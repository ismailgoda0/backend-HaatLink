import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { sanitizeFilename, validateUrlForServerAccess } from '../security/ssrfValidator';
import { spawnYtDlp, isYtDlpAvailable, isFfmpegAvailable, getFfmpegPath, terminateProcessTree } from '../utils/binaryHelper';
import { spawn } from 'child_process';
import { config } from '../../config/env';

export interface CachedServerMedia {
  id: string;
  ownerId: string;
  url: string;
  title: string;
  platform: string;
  quality: string;
  format: string;
  duration?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileSizeFormatted: string;
  cachedAt: number;
  status: 'ready' | 'downloading' | 'failed';
  progress?: number;
  audioFilePath?: string;
  transcript?: string;
  error?: string;
}

class ServerMediaCacheManager extends EventEmitter {
  private cacheDir: string;
  private registryPath: string;
  private items: Map<string, CachedServerMedia> = new Map();
  private initialized = false;
  private readonly maxBytes = Number(config.maxCacheSizeBytes || 5 * 1024 * 1024 * 1024);
  private readonly maxItems = Number(config.maxCacheItems || 100);
  private readonly ttlMs = Number(config.cacheItemTtlMs || 7 * 24 * 60 * 60 * 1000);
  private readonly maxItemBytes = Number(config.maxCacheItemBytes || 1024 * 1024 * 1024);
  private readonly maxAudioBytes = Number(config.maxCacheAudioBytes || 100 * 1024 * 1024);
  private reservedBytes = 0;
  private reservedItems = 0;

  constructor() {
    super();
    this.cacheDir = config.serverCacheDir || path.join(process.cwd(), 'data', 'server_cache');
    this.registryPath = path.join(this.cacheDir, 'server_media_registry.json');
    this.init();
  }

  private init() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      if (fs.existsSync(this.registryPath)) {
        const raw = fs.readFileSync(this.registryPath, 'utf8');
        const list: CachedServerMedia[] = JSON.parse(raw);
        for (const item of list) {
          if (fs.existsSync(item.filePath)) {
            this.items.set(item.id, item);
          }
        }
      }
      this.initialized = true;
      this.cleanupExpired();
    } catch (e) {
      console.error('Failed to initialize server media cache registry:', e);
      this.initialized = true;
    }
  }

  private saveRegistry() {
    try {
      const list = Array.from(this.items.values()).filter((it) => it.status === 'ready');
      const tmp = `${this.registryPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8'); fs.renameSync(tmp, this.registryPath);
    } catch (e) {
      console.error('Failed to save server media cache registry:', e);
    }
  }

  public getAll(): CachedServerMedia[] {
    return Array.from(this.items.values())
      .filter((it) => it.status === 'ready' && fs.existsSync(it.filePath))
      .sort((a, b) => b.cachedAt - a.cachedAt);
  }

  public getById(id: string, ownerId: string): CachedServerMedia | undefined {
    const item = this.items.get(id);
    if (item && item.ownerId !== ownerId) return undefined;
    if (item && item.status === 'ready' && !fs.existsSync(item.filePath)) {
      this.items.delete(id);
      this.saveRegistry();
      return undefined;
    }
    return item;
  }

  public getByUrl(url: string, ownerId: string): CachedServerMedia[] {
    if (!url) return [];
    const clean = url.trim().toLowerCase();
    return this.getAll().filter((it) => it.url.trim().toLowerCase() === clean && it.ownerId === ownerId);
  }

  public delete(id: string, ownerId?: string): boolean {
    const item = this.items.get(id);
    if (!item || (ownerId && item.ownerId !== ownerId)) return false;

    try {
      if (fs.existsSync(item.filePath)) {
        fs.unlinkSync(item.filePath);
      }
      if (item.audioFilePath && fs.existsSync(item.audioFilePath)) {
        fs.unlinkSync(item.audioFilePath);
      }
    } catch {}

    this.items.delete(id);
    this.saveRegistry();
    this.emit('deleted', id);
    return true;
  }

  public setTranscript(id: string, ownerId: string, transcript: string) {
    const item = this.items.get(id);
    if (item && item.ownerId === ownerId) {
      item.transcript = transcript;
      this.saveRegistry();
    }
  }

  public async ingest(params: {
    ownerId?: string;
    url: string;
    title: string;
    platform: string;
    quality?: string;
    format?: string;
    duration?: string;
    durationSeconds?: number;
    thumbnailUrl?: string;
  }): Promise<CachedServerMedia> {
    const ownerId = params.ownerId || 'anonymous';
    const existing = this.getByUrl(params.url, ownerId).find((it) => it.status === 'ready');
    if (existing) {
      return existing;
    }

    const safety = await validateUrlForServerAccess(params.url);
    if (!safety.safe) {
      throw new Error(safety.error || 'Prohibited media URL');
    }

    const readyItems = this.getAll();
    const usedBytes = readyItems.reduce((sum, it) => sum + (it.fileSize || 0), 0);
    const projectedReservations = usedBytes + this.reservedBytes;
    if (readyItems.length + this.reservedItems >= this.maxItems ||
        projectedReservations >= this.maxBytes) {
      throw new Error('Server cache quota is currently full.');
    }
    this.reservedItems++;
    this.reservedBytes += this.maxItemBytes;
    const id = `cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const safeTitle = sanitizeFilename(params.title || 'media');
    const targetFormat = params.format || 'mp4';
    const targetQuality = params.quality || '720p';
    const fileName = `${safeTitle}.${targetFormat}`;
    const outputTemplate = path.join(this.cacheDir, `${id}.%(ext)s`);

    const cachedItem: CachedServerMedia = {
      id,
      ownerId,
      url: params.url.trim(),
      title: params.title || 'Media Video',
      platform: params.platform || 'web',
      quality: targetQuality,
      format: targetFormat,
      duration: params.duration,
      durationSeconds: params.durationSeconds,
      thumbnailUrl: params.thumbnailUrl,
      filePath: '',
      fileName,
      fileSize: 0,
      fileSizeFormatted: '-- MB',
      cachedAt: Date.now(),
      status: 'downloading',
      progress: 0,
    };

    this.items.set(id, cachedItem);
    this.emit('progress', cachedItem);

    // Download in background
    (async () => {
      try {
        const hasFfmpeg = isFfmpegAvailable();
        const maxHeight = targetQuality === '1080p' ? 1080 : 720;
        const args = [
          '--newline',
          '--no-warnings',
          '--progress',
          '--socket-timeout', '30',
          '--retries', '3',
          '--force-ipv4',
          '--max-filesize', String(this.maxItemBytes),
          '--no-playlist',
          '-o', outputTemplate,
        ];

        if (hasFfmpeg) {
          args.push(
            '-f', `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
            '--merge-output-format', 'mp4'
          );
        } else {
          args.push('-f', `best[height<=${maxHeight}]/bestvideo[height<=${maxHeight}]+bestaudio/best`);
        }

        args.push(params.url);

        const child = spawnYtDlp(args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const timeout = setTimeout(() => {
          terminateProcessTree(child);
        }, Number(config.cacheDownloadTimeoutMs || 15 * 60 * 1000));

        child.stdout?.on('data', (buf) => {
          for (const line of buf.toString().split(/\r?\n/)) {
            const match = line.match(/(\d+(?:\.\d+)?)%/);
            if (match) {
              const p = Math.min(99, Math.round(parseFloat(match[1])));
              cachedItem.progress = p;
              this.emit('progress', cachedItem);
            }
          }
        });

        child.on('close', async (code) => {
          clearTimeout(timeout);
          this.reservedItems = Math.max(0, this.reservedItems - 1);
          this.reservedBytes = Math.max(0, this.reservedBytes - this.maxItemBytes);
          if (code !== 0) {
            cachedItem.status = 'failed';
            cachedItem.error = `yt-dlp exited with code ${code}`;
            this.emit('progress', cachedItem);
            return;
          }

          // Find downloaded file
          const files = fs.readdirSync(this.cacheDir).filter((f) => f.startsWith(`${id}.`));
          const finalFile = files[0] ? path.join(this.cacheDir, files[0]) : null;

          if (!finalFile || !fs.existsSync(finalFile)) {
            cachedItem.status = 'failed';
            cachedItem.error = 'File not found on disk after download';
            this.emit('progress', cachedItem);
            return;
          }

          const stat = fs.statSync(finalFile);
          if (stat.size > this.maxItemBytes) {
            try { fs.unlinkSync(finalFile); } catch {}
            cachedItem.status = 'failed';
            cachedItem.error = 'Cached media exceeds the configured per-item limit';
            this.emit('progress', cachedItem);
            return;
          }
          cachedItem.filePath = finalFile;
          cachedItem.fileSize = stat.size;
          cachedItem.fileSizeFormatted = (stat.size / (1024 * 1024)).toFixed(1) + ' MB';
          cachedItem.status = 'ready';
          cachedItem.progress = 100;

          // Attempt to extract light audio for Gemini if FFmpeg is available
          try {
            const audioPath = path.join(this.cacheDir, `${id}.mp3`);
            await this.extractAudio(finalFile, audioPath);
            if (fs.existsSync(audioPath)) {
              cachedItem.audioFilePath = audioPath;
            }
          } catch (audioErr) {
            console.warn('Audio extraction failed (will use video directly if needed):', audioErr);
          }

          const totalBytes = (fs.existsSync(finalFile) ? fs.statSync(finalFile).size : 0) +
            (cachedItem.audioFilePath && fs.existsSync(cachedItem.audioFilePath) ? fs.statSync(cachedItem.audioFilePath).size : 0);
          if (totalBytes > this.maxBytes) {
            this.delete(cachedItem.id);
            cachedItem.status = 'failed';
            cachedItem.error = 'Cached media exceeds the total server cache limit';
            this.emit('progress', cachedItem);
            return;
          }
          this.saveRegistry();
          this.emit('progress', cachedItem);
          this.emit('ready', cachedItem);
        });

        child.on('error', (err) => {
          cachedItem.status = 'failed';
          cachedItem.error = err.message;
          this.emit('progress', cachedItem);
        });
      } catch (err: any) {
        cachedItem.status = 'failed';
        cachedItem.error = err.message;
        this.emit('progress', cachedItem);
      }
    })();

    return cachedItem;
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const item of [...this.items.values()]) {
      if ((item.status === 'ready' && now - item.cachedAt > this.ttlMs) || item.status === 'failed') this.delete(item.id);
    }
  }

  private extractAudio(videoPath: string, outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = getFfmpegPath();
      if (!ffmpeg) return resolve();

      const args = ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-fs', String(this.maxAudioBytes), outPath];
      const p = spawn(ffmpeg, args, { stdio: 'ignore' });
      const timer = setTimeout(() => p.kill('SIGKILL'), Number(config.cacheAudioTimeoutMs || 5 * 60 * 1000));
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}`));
      });
      p.on('error', reject);
    });
  }
}

export const serverMediaCache = new ServerMediaCacheManager();
