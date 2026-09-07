import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class TikTokProvider extends BaseProvider {
  readonly platform: PlatformId = 'tiktok';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('tiktok.com') || u.includes('douyin.com');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || data.description || 'TikTok Video';
    const author = data.uploader || data.creator || '@tiktok_user';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'tiktok-hd-nowatermark',
        label: 'Original HD (Watermark-Free MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        watermarkFree: true,
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'tiktok-sd-nowatermark',
        label: 'Balanced SD (Watermark-Free MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        watermarkFree: true,
        tier: 'best_balance',
      },
      {
        id: 'tiktok-audio-mp3',
        label: 'Original TikTok Audio (MP3 320k)',
        quality: '320k',
        extension: 'mp3',
        type: 'audio',
        bitrate: '320 kbps',
      },
      {
        id: 'tiktok-audio-m4a',
        label: 'Original TikTok Audio (M4A 256k)',
        quality: '256k',
        extension: 'm4a',
        type: 'audio',
        bitrate: '256 kbps',
      },
    ];

    return {
      url: cleanUrl,
      title,
      author,
      authorUrl: data.uploader_url,
      platform: 'tiktok',
      category: 'video',
      thumbnailUrl,
      duration,
      durationSeconds,
      views: data.view_count ? Number(data.view_count).toLocaleString() : undefined,
      likes: data.like_count ? Number(data.like_count).toLocaleString() : undefined,
      description: data.description,
      formats,
    };
  }
}
