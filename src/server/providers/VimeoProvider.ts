import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class VimeoProvider extends BaseProvider {
  readonly platform: PlatformId = 'vimeo';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('vimeo.com');
  }

  private extractVimeoId(url: string): string | null {
    const match = url.match(/vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d+)/i);
    return match ? match[1] : null;
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();
    const vimeoId = this.extractVimeoId(cleanUrl);

    // Prefer player URL as Vimeo restricts direct web page extraction without login
    const targetUrl = vimeoId ? `https://player.vimeo.com/video/${vimeoId}` : cleanUrl;

    // First try oEmbed for Vimeo public metadata
    let oembed: any = null;
    try {
      const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(cleanUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (res.ok) {
        oembed = await res.json();
      }
    } catch {
      // ignore
    }

    try {
      const dumpArgs = [
        '--dump-single-json',
        '--no-warnings',
        targetUrl,
      ];
      const data = await this.runYtDlpDump(dumpArgs);
      const title = data.title || oembed?.title || 'Vimeo Video';
      const author = data.uploader || oembed?.author_name || 'Vimeo Filmmaker';
      const durationSeconds = data.duration || oembed?.duration || 0;
      const duration = this.formatDuration(durationSeconds);
      const thumbnailUrl = data.thumbnail || oembed?.thumbnail_url || '';

      const formats: ServerMediaFormat[] = [
        {
          id: 'vimeo-1080p',
          label: 'Crisp 1080p Full HD (MP4)',
          quality: '1080p',
          extension: 'mp4',
          type: 'video',
          recommended: true,
          tier: 'best_quality',
        },
        {
          id: 'vimeo-720p',
          label: 'Balanced 720p HD (MP4)',
          quality: '720p',
          extension: 'mp4',
          type: 'video',
          tier: 'best_balance',
        },
        {
          id: 'vimeo-audio',
          label: 'Soundtrack Audio (MP3 320k)',
          quality: '320k',
          extension: 'mp3',
          type: 'audio',
        },
      ];

      return {
        url: cleanUrl,
        title,
        author,
        authorUrl: data.uploader_url || oembed?.author_url,
        platform: 'vimeo',
        category: 'video',
        thumbnailUrl,
        duration,
        durationSeconds,
        description: data.description || oembed?.description,
        formats,
      };
    } catch (err: any) {
      if (oembed) {
        return {
          url: cleanUrl,
          title: oembed.title || 'Vimeo Video',
          author: oembed.author_name || 'Vimeo Filmmaker',
          authorUrl: oembed.author_url,
          platform: 'vimeo',
          category: 'video',
          thumbnailUrl: oembed.thumbnail_url || '',
          duration: undefined,
          durationSeconds: undefined,
          formats: [
            { id: 'vimeo-1080p-fallback', label: 'Direct 1080p Stream (MP4)', quality: '1080p', extension: 'mp4', type: 'video', recommended: true, tier: 'best_quality' },
            { id: 'vimeo-720p-fallback', label: 'Balanced 720p HD (MP4)', quality: '720p', extension: 'mp4', type: 'video', tier: 'best_balance' },
            { id: 'vimeo-audio-fallback', label: 'Soundtrack Audio (MP3 320k)', quality: '320k', extension: 'mp3', type: 'audio' },
          ],
        };
      }
      throw err;
    }
  }
}
