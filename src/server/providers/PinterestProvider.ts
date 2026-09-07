import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class PinterestProvider extends BaseProvider {
  readonly platform: PlatformId = 'pinterest';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('pinterest.com') || u.includes('pin.it');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || data.description || 'Pinterest Video';
    const author = data.uploader || 'Pinterest Creator';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'pin-video-hd',
        label: 'Original 1080p Video (MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'pin-video-sd',
        label: 'Standard 720p Video (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
    ];

    return {
      url: cleanUrl,
      title,
      author,
      authorUrl: data.uploader_url,
      platform: 'pinterest',
      category: 'video',
      thumbnailUrl,
      duration,
      durationSeconds,
      description: data.description,
      formats,
    };
  }
}
