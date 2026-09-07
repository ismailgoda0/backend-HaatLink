import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class InstagramProvider extends BaseProvider {
  readonly platform: PlatformId = 'instagram';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('instagram.com') || u.includes('instagr.am');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    const data = await this.runYtDlpDump(dumpArgs);

    const title = data.title || data.description?.slice(0, 80) || 'Instagram Reel';
    const author = data.uploader || data.channel || '@instagram_creator';
    const durationSeconds = data.duration || 0;
    const duration = this.formatDuration(durationSeconds);
    const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    const formats: ServerMediaFormat[] = [
      {
        id: 'ig-video-hd',
        label: 'Original 1080p Reel (MP4)',
        quality: '1080p',
        extension: 'mp4',
        type: 'video',
        recommended: true,
        tier: 'best_quality',
      },
      {
        id: 'ig-video-sd',
        label: 'Balanced 720p Reel (MP4)',
        quality: '720p',
        extension: 'mp4',
        type: 'video',
        tier: 'best_balance',
      },
      {
        id: 'ig-audio-mp3',
        label: 'Extracted Reel Audio (MP3 320k)',
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
      platform: 'instagram',
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
