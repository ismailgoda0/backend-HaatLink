import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class DailymotionProvider extends BaseProvider {
  readonly platform: PlatformId = 'dailymotion';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('dailymotion.com') || u.includes('dai.ly');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || 'Dailymotion Video';
    const author = data.uploader || 'Dailymotion Creator';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'dm-1080p',
        label: '1080p HD (MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'dm-720p',
        label: '720p HD (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
      {
        id: 'dm-audio',
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
      platform: 'dailymotion',
      category: 'video',
      thumbnailUrl,
      duration,
      durationSeconds,
      formats,
    };
  }
}
