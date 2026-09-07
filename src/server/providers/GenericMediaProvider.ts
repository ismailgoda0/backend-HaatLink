import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';
import { URL } from 'url';
import { validateUrlForServerAccess } from '../security/ssrfValidator';

export class GenericMediaProvider extends BaseProvider {
  readonly platform: PlatformId = 'generic';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    const directExtensions = ['.mp4', '.webm', '.mp3', '.m4a', '.wav', '.ogg', '.mov', '.m3u8', '.mkv'];
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase();
      return directExtensions.some((ext) => pathname.endsWith(ext));
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      throw new Error('Invalid media URL');
    }

    // HEAD is optional metadata enrichment, but every redirect target is revalidated.
    let contentType = '';
    let contentLength = 0;
    let filenameFromHeader = '';

    try {
      let currentUrl = cleanUrl;
      for (let hop = 0; hop < 4; hop++) {
        const check = await validateUrlForServerAccess(currentUrl);
        if (!check.safe) throw new Error(check.error);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const headRes = await fetch(currentUrl, {
          method: 'HEAD', redirect: 'manual', signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 HaatLink/1.0', Accept: '*/*' },
        });
        clearTimeout(timeout);
        if (headRes.status >= 300 && headRes.status < 400) {
          const location = headRes.headers.get('location');
          if (!location) break;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        if (headRes.ok) {
          contentType = headRes.headers.get('content-type') || '';
          const cl = headRes.headers.get('content-length');
          if (cl) contentLength = Number.parseInt(cl, 10) || 0;
          const cd = headRes.headers.get('content-disposition');
          if (cd) { const match = cd.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i); if (match) filenameFromHeader = decodeURIComponent(match[1]); }
        }
        break;
      }
    } catch { /* Metadata probing is best-effort. */ }

    // Extract filename from URL or header
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1] || 'media';
    const cleanFileName = filenameFromHeader || decodeURIComponent(lastPart).split('?')[0];

    // Detect if video or audio
    const isAudio =
      contentType.includes('audio') ||
      cleanFileName.endsWith('.mp3') ||
      cleanFileName.endsWith('.m4a') ||
      cleanFileName.endsWith('.wav') ||
      cleanFileName.endsWith('.ogg');

    const extension = cleanFileName.split('.').pop()?.toLowerCase() || (isAudio ? 'mp3' : 'mp4');
    const title = cleanFileName.replace(/\.[^/.]+$/, '') || 'Direct Media Resource';

    const formats: ServerMediaFormat[] = [];

    if (isAudio) {
      formats.push({
        id: 'direct-audio-orig',
        label: `Direct Stream (${extension.toUpperCase()})`,
        quality: 'Original',
        extension: (['mp3', 'm4a', 'wav'].includes(extension) ? extension : 'mp3') as any,
        type: 'audio',
        filesize: contentLength ? this.formatBytes(contentLength) : undefined,
        filesizeBytes: contentLength || undefined,
        recommended: true,
        tier: 'best_quality',
      });
      formats.push({
        id: 'direct-audio-mp3',
        label: 'MP3 Audio (320kbps Conversion)',
        quality: '320k',
        extension: 'mp3',
        type: 'audio',
        tier: 'best_balance',
      });
    } else {
      formats.push({
        id: 'direct-video-orig',
        label: `Direct Source Stream (${extension.toUpperCase()})`,
        quality: 'Original',
        extension: (['mp4', 'webm'].includes(extension) ? extension : 'mp4') as any,
        type: 'video',
        filesize: contentLength ? this.formatBytes(contentLength) : undefined,
        filesizeBytes: contentLength || undefined,
        recommended: true,
        tier: 'best_quality',
      });
      formats.push({
        id: 'direct-audio-extract',
        label: 'Extracted Soundtrack (MP3 320k)',
        quality: '320k',
        extension: 'mp3',
        type: 'audio',
        tier: 'best_balance',
      });
    }

    return {
      url: cleanUrl,
      title,
      author: parsed.hostname,
      authorUrl: `${parsed.protocol}//${parsed.hostname}`,
      platform: 'generic',
      category: isAudio ? 'audio' : 'video',
      thumbnailUrl: isAudio
        ? 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=800&auto=format&fit=crop&q=80'
        : 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=800&auto=format&fit=crop&q=80',
      formats,
    };
  }
}
