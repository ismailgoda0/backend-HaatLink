import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class TwitchProvider extends BaseProvider {
  readonly platform: PlatformId = 'twitch';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('twitch.tv');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || 'Twitch Clip';
    const author = data.uploader || data.creator || 'Twitch Streamer';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'twitch-1080p',
        label: 'Source 1080p 60fps (MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'twitch-720p',
        label: 'Balanced 720p 60fps (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
      {
        id: 'twitch-audio',
        label: 'Audio Stream (MP3 320k)',
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
      platform: 'twitch',
      category: 'video',
      thumbnailUrl,
      duration,
      durationSeconds,
      formats,
    };
  }
}
