import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class TwitterProvider extends BaseProvider {
  readonly platform: PlatformId = 'twitter';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('twitter.com') || u.includes('x.com');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || data.description?.slice(0, 100) || 'X (Twitter) Post';
    const author = data.uploader || data.channel || '@x_user';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'twitter-hd',
        label: 'Original 1080p Video (MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'twitter-sd',
        label: 'Balanced 720p Video (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
      {
        id: 'twitter-audio',
        label: 'Extracted Voice/Audio (MP3)',
        quality: '320k',
        extension: 'mp3',
        type: 'audio',
      },
    ];

    return {
      url: cleanUrl,
      title,
      author,
      authorUrl: data.uploader_url,
      platform: 'twitter',
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
