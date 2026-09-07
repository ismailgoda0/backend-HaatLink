import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class RedditProvider extends BaseProvider {
  readonly platform: PlatformId = 'reddit';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('reddit.com') || u.includes('redd.it');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || 'Reddit Video';
    const author = data.uploader || 'Reddit User';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'reddit-merged-hd',
        label: 'Original 1080p Video (Audio Merged MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'reddit-merged-sd',
        label: 'Balanced 720p Video (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
      {
        id: 'reddit-audio-mp3',
        label: 'Extracted Audio Track (MP3)',
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
      platform: 'reddit',
      category: 'video',
      thumbnailUrl,
      duration,
      durationSeconds,
      likes: data.like_count ? Number(data.like_count).toLocaleString() : undefined,
      description: data.description,
      formats,
    };
  }
}
