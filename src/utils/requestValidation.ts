import type { DownloadRange } from '../server/media/downloadEngine';
import { config } from '../config/env';

export async function readResponseTextLimited(resp: globalThis.Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(resp.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Response exceeds the configured size limit');
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Response exceeds the configured size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function getAllowedQuality(quality: string): string {
  const normalized = String(quality || '1080p').toLowerCase();
  const allowed = ['144p','240p','360p','480p','720p','1080p','1440p','2160p','4k','2k','hd','320k','256k','192k','128k'];
  return allowed.includes(normalized) ? normalized : '1080p';
}

function parseRange(body: any): DownloadRange | undefined {
  if (body?.startSeconds === undefined && body?.endSeconds === undefined) return undefined;
  const start = Number(body.startSeconds);
  const end = Number(body.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid time range');
  if (end - start > Number(config.maxRangeSeconds || 4 * 60 * 60)) throw new Error('Requested time range is too long');
  return { startSeconds: Math.floor(start), endSeconds: Math.floor(end) };
}

export function validateDownloadInput(body: any) {
  if (!body || typeof body.url !== 'string' || !body.url.trim()) throw new Error('URL is required');
  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : 'media';
  const format = typeof body.format === 'string' ? body.format.toLowerCase() : 'mp4';
  const quality = getAllowedQuality(typeof body.quality === 'string' ? body.quality : '1080p');
  const type = body.type === 'audio' || body.type === 'subtitle' ? body.type : 'video';
  const allowed = ['mp4','webm','mp3','m4a','wav','srt','vtt'];
  if (!allowed.includes(format)) throw new Error('Unsupported format');
  if (type === 'video' && !['mp4','webm'].includes(format)) throw new Error('Video jobs require mp4 or webm');
  if (type === 'audio' && !['mp3','m4a','wav','webm'].includes(format)) throw new Error('Audio jobs require mp3, m4a, wav or webm');
  const muteAudio = Boolean(body.muteAudio || body.mute === 'true' || body.mute === true);
  const burnSubtitles = Boolean(body.burnSubtitles || body.hardsub === 'true' || body.hardsub === true);
  const subtitleLang = typeof body.subtitleLang === 'string' ? body.subtitleLang.slice(0, 32) : 'ar';
  const sourceFormatId = typeof body.sourceFormatId === 'string' && /^[0-9+_.-]{1,80}$/.test(body.sourceFormatId) ? body.sourceFormatId : undefined;
  const sourceHasAudio = body.sourceHasAudio === true || body.sourceHasAudio === 'true';
  return { url: body.url.trim(), title, format, quality, type, range: parseRange(body), muteAudio, burnSubtitles, subtitleLang, sourceFormatId, sourceHasAudio } as const;
}
