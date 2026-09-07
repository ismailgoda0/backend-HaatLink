import { ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { sanitizeFilename, validateUrlForServerAccess } from '../security/ssrfValidator';
import { spawnYtDlp, isYtDlpAvailable, isFfmpegAvailable, terminateProcessTree } from '../utils/binaryHelper';
import { config } from '../../config/env';

export type DownloadRange = { startSeconds?: number; endSeconds?: number };

export interface DownloadJob {
  id: string; ownerId: string; url: string; title: string; format: string; quality: string; sourceFormatId?: string; sourceHasAudio?: boolean;
  type: 'video' | 'audio' | 'subtitle';
  status: 'queued' | 'downloading' | 'converting' | 'completed' | 'failed' | 'cancelled';
  progress: number; downloadedBytes: number; totalBytes: number; speed: string; eta: string;
  filePath?: string; fileName: string; error?: string; createdAt: number; completedAt?: number;
  process?: ChildProcess; listeners: ((job: DownloadJob) => void)[]; range?: DownloadRange;
  muteAudio?: boolean;
  burnSubtitles?: boolean;
  subtitleLang?: string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class DownloadEngine {
  private jobs = new Map<string, DownloadJob>();
  private queue: string[] = [];
  private running = 0;
  private readonly maxConcurrent = Math.max(1, Number(config.maxConcurrentDownloads || 4));
  private readonly maxQueueSize = Math.max(this.maxConcurrent, Number(config.maxQueueSize || 50));
  private readonly maxConcurrentPerUser = Math.max(1, Number(config.maxConcurrentPerUser || 2));
  private readonly maxFileBytes = Number(config.maxDownloadBytes || 2 * 1024 * 1024 * 1024);
  private readonly tempDir = config.tempDir || path.join(os.tmpdir(), 'haatlink_downloads');

  constructor() {
    fs.mkdirSync(this.tempDir, { recursive: true });
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  getJob(id: string) { return this.jobs.get(id); }

  createJob(params: {
    url: string;
    title: string;
    format: string;
    quality: string;
    type: 'video' | 'audio' | 'subtitle';
    range?: DownloadRange;
    muteAudio?: boolean;
    burnSubtitles?: boolean;
    subtitleLang?: string;
    sourceFormatId?: string;
    sourceHasAudio?: boolean;
    ownerId?: string;
  }): DownloadJob {
    const ownerId = params.ownerId || 'anonymous';
    const activeForOwner = [...this.jobs.values()].filter((j) => j.ownerId === ownerId && !TERMINAL.has(j.status)).length;
    if (this.queue.length >= this.maxQueueSize) throw new Error('SERVER_BUSY: Download queue is full. Please try again shortly.');
    if (activeForOwner >= this.maxConcurrentPerUser) throw new Error('USER_QUEUE_LIMIT: Too many active downloads for this session.');
    const id = `haat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const safeTitle = sanitizeFilename(params.title);
    const ext = ['mp4','webm','mp3','m4a','wav','srt','vtt'].includes(params.format) ? params.format : 'mp4';
    const job: DownloadJob = {
      id, ownerId, url: params.url.trim(), title: params.title, format: ext, quality: params.quality, sourceFormatId: params.sourceFormatId, sourceHasAudio: params.sourceHasAudio,
      type: params.type, status: 'queued', progress: 0, downloadedBytes: 0, totalBytes: 0,
      speed: '0 MB/s', eta: '--:--', fileName: `${safeTitle}.${ext}`, createdAt: Date.now(),
      listeners: [], range: params.range, muteAudio: Boolean(params.muteAudio),
      burnSubtitles: Boolean(params.burnSubtitles),
      subtitleLang: params.subtitleLang || 'ar',
    };
    this.jobs.set(id, job); this.queue.push(id); this.pump(); return job;
  }

  subscribe(id: string, listener: (job: DownloadJob) => void) {
    const job = this.jobs.get(id); if (!job) return () => {};
    job.listeners.push(listener); return () => { job.listeners = job.listeners.filter((x) => x !== listener); };
  }

  cancelJob(id: string) {
    const job = this.jobs.get(id); if (!job || TERMINAL.has(job.status)) return false;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((x) => x !== id);
      job.status = 'cancelled'; this.notify(job); this.pruneJobLater(job); return true;
    }
    if (job.process && !job.process.killed) terminateProcessTree(job.process)
    job.status = 'cancelled'; this.notify(job); return true;
  }


  private pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!; const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running++;
      this.execute(job).finally(() => { this.running--; this.pump(); });
    }
  }

  private async execute(job: DownloadJob) {
    const safety = await validateUrlForServerAccess(job.url);
    if (!safety.safe) return this.fail(job, safety.error || 'Prohibited URL');
    if (!isYtDlpAvailable()) return this.fail(job, 'yt-dlp executable was not found on the server');

    job.status = 'downloading'; this.notify(job);
    const outputTemplate = path.join(this.tempDir, `${job.id}.%(ext)s`);
    const args = [
      '--newline', '--no-warnings', '--progress', '--socket-timeout', config.ytdlpSocketTimeout || '25',
      '--retries', config.ytdlpRetries || '2', '--fragment-retries', '2', '--force-ipv4',
      '--max-filesize', String(this.maxFileBytes),
      '--progress-template', 'download:%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '-o', outputTemplate,
      '--no-playlist',
    ];

    const ext = job.format.toLowerCase();
    const hasFfmpeg = isFfmpegAvailable();

    if (job.type === 'subtitle' || ext === 'srt' || ext === 'vtt') {
      args.push('--write-subs', '--sub-format', ext, '--sub-langs', job.subtitleLang || 'ar', '--skip-download');
    } else if (job.type === 'audio' || ['mp3','m4a','wav','webm'].includes(ext)) {
      const safeFormatId = job.sourceFormatId?.replace(/[^0-9+_.-]/g, '');
      args.push('-f', safeFormatId || 'bestaudio/best');
      if (hasFfmpeg && ext !== 'webm') args.push('-x', '--audio-format', ext, '--audio-quality', '0');
    } else {
      const maxHeight = ({'4K':2160,'2160p':2160,'2K':1440,'1440p':1440,'1080p':1080,'720p':720,'480p':480,'360p':360,'240p':240,'144p':144}[job.quality] || 1080);
      const container = ext === 'webm' ? 'webm' : 'mp4';
      if (job.sourceFormatId) {
        const safeFormatId = job.sourceFormatId.replace(/[^0-9+_.-]/g, '');
        if (job.muteAudio) {
          args.push('-f', safeFormatId, '--merge-output-format', container);
          if (hasFfmpeg && container === 'mp4') args.push('--recode-video', 'mp4', '--postprocessor-args', 'ffmpeg:-an');
        } else if (job.sourceHasAudio) {
          args.push('-f', safeFormatId, '--merge-output-format', container);
          if (hasFfmpeg && container === 'mp4') args.push('--recode-video', 'mp4');
        } else {
          args.push('-f', `${safeFormatId}+bestaudio/${safeFormatId}/best`, '--merge-output-format', container);
          if (hasFfmpeg && container === 'mp4') args.push('--recode-video', 'mp4');
        }
      } else if (job.muteAudio) {
        if (hasFfmpeg) {
          args.push('-f', `bestvideo[height<=${maxHeight}][ext=${container}]/bestvideo[height<=${maxHeight}]/bestvideo`, '--merge-output-format', container, '--postprocessor-args', 'ffmpeg:-an');
          if (container === 'mp4') args.push('--recode-video', 'mp4');
        } else {
          args.push('-f', `bestvideo[height<=${maxHeight}]/bestvideo`);
        }
      } else if (hasFfmpeg) {
        args.push('-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`, '--merge-output-format', container);
        if (container === 'mp4') args.push('--recode-video', 'mp4');
      } else {
        // Fallback when FFmpeg is not installed: download best pre-merged progressive stream
        args.push('-f', `best[height<=${maxHeight}]/bestvideo[height<=${maxHeight}]+bestaudio/best`);
      }

      if (job.burnSubtitles) {
        const subLang = job.subtitleLang || 'ar';
        args.push(
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs', `${subLang},${subLang}-*,en,en-*`,
          '--embed-subs'
        );
      }
    }

    if (job.range && job.range.startSeconds !== undefined && job.range.endSeconds !== undefined) {
      const start = Math.max(0, Math.floor(job.range.startSeconds));
      const end = Math.max(start + 1, Math.floor(job.range.endSeconds));
      args.push('--download-sections', `*${start}-${end}`);
      if (hasFfmpeg) {
        args.push('--force-keyframes-at-cuts');
      }
    }
    args.push(job.url);

    await new Promise<void>((resolve) => {
      const timeoutMs = Number(config.downloadTimeoutMs || 20 * 60 * 1000);
      const child = spawnYtDlp(args, { stdio: ['ignore','pipe','pipe'] });
      job.process = child;
      let stderr = '';
      const timer = setTimeout(() => terminateProcessTree(child), timeoutMs);

      child.stdout.on('data', (data) => {
        for (const line of data.toString().split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.startsWith('download:')) {
            const [p, d, total, speed, eta] = trimmed.slice(9).split('|');
            const percent = Number.parseFloat((p || '').replace('%',''));
            if (Number.isFinite(percent)) job.progress = Math.min(99, Math.max(0, Math.round(percent)));
            const downloaded = Number.parseInt(d || '0', 10); const totalBytes = Number.parseInt(total || '0', 10);
            if (downloaded > 0) job.downloadedBytes = downloaded; if (totalBytes > 0) job.totalBytes = totalBytes;
            if (speed) job.speed = speed.trim(); if (eta) job.eta = eta.trim(); this.notify(job);
          } else if (/\[(ExtractAudio|Merger|VideoConvertor)\]/.test(trimmed)) {
            job.status = 'converting'; job.progress = Math.max(job.progress, 95); job.speed = 'Post-processing…'; this.notify(job);
          }
        }
      });
      child.stderr.on('data', (data) => { stderr += data.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
      child.once('error', (err) => { clearTimeout(timer); if (!TERMINAL.has(job.status)) this.fail(job, err.message); resolve(); });
      child.once('close', (code) => {
        clearTimeout(timer); job.process = undefined;
        if (job.status === 'cancelled') { this.removeOutput(job.id); this.pruneJobLater(job); return resolve(); }
        if (code !== 0) { this.fail(job, this.classifyError(stderr, code)); return resolve(); }
        const file = this.findOutput(job.id);
        if (!file) { this.fail(job, 'Downloaded file could not be verified on disk'); return resolve(); }
        const stat = fs.statSync(file);
        if (stat.size > this.maxFileBytes) { this.removeFile(file); this.fail(job, 'Downloaded file exceeds the configured size limit'); return resolve(); }
        job.filePath = file; job.status = 'completed'; job.progress = 100; job.downloadedBytes = stat.size; job.totalBytes = stat.size; job.completedAt = Date.now(); this.notify(job); this.pruneJobLater(job); resolve();
      });
    });
  }

  private classifyError(stderr: string, code: number | null) {
    const e = stderr.trim();
    if (/404|Not Found|does not exist/i.test(e)) return 'MEDIA_NOT_FOUND: Media not found or removed.';
    if (/Private video|This video is private/i.test(e)) return 'PRIVATE_MEDIA: This media is private or restricted.';
    if (/Sign in|login required|bot check/i.test(e)) return 'LOGIN_REQUIRED: Login or bot verification is required.';
    if (/Cannot parse data/i.test(e)) return 'CANNOT_PARSE_DATA: Unable to parse platform media streams.';
    if (/filesize.*exceeds|larger than/i.test(e)) return 'FILE_TOO_LARGE: The requested media exceeds the server size limit.';
    return (e.split('\n').filter(Boolean).pop() || `yt-dlp failed with exit code ${code}`).slice(0, 240);
  }

  private fail(job: DownloadJob, error: string) { if (TERMINAL.has(job.status)) return; job.status = 'failed'; job.error = error.slice(0, 300); job.process = undefined; this.notify(job); this.pruneJobLater(job); }
  private findOutput(id: string) { return fs.readdirSync(this.tempDir).filter((f) => f.startsWith(`${id}.`)).map((f) => path.join(this.tempDir,f)).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }); }
  private removeFile(file?: string) { if (file) try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {} }
  private removeOutput(id: string) { this.removeFile(this.findOutput(id)); }
  private notify(job: DownloadJob) { for (const l of [...job.listeners]) try { l(job); } catch {} }
  private pruneJobLater(job: DownloadJob) { setTimeout(() => { if (TERMINAL.has(job.status)) { job.listeners = []; job.process = undefined; } }, Number(config.jobTtlMs || 60 * 60 * 1000)).unref(); }
  private cleanup() {
    const now = Date.now();
    for (const file of fs.readdirSync(this.tempDir)) {
      const full = path.join(this.tempDir, file);
      try { const stat = fs.statSync(full); if (now - stat.mtimeMs > 30 * 60 * 1000) fs.unlinkSync(full); } catch {}
    }
    for (const [id, job] of this.jobs) if (TERMINAL.has(job.status) && now - (job.completedAt || job.createdAt) > 60 * 60 * 1000) this.jobs.delete(id);
  }
}
export const downloadEngine = new DownloadEngine();
