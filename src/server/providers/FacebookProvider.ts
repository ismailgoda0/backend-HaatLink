import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';

export class FacebookProvider extends BaseProvider {
  readonly platform: PlatformId = 'facebook';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com');
  }

  async resolve(url: string, rawHtml?: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    // 1. Private / Source HTML extraction mode
    if (rawHtml && rawHtml.trim()) {
      const html = rawHtml;

      // Extract title
      const titleMatch =
        html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
        html.match(/<title>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/ - Facebook$/, '').replace(/ \| Facebook$/, '').trim() : 'Facebook Video';

      // Extract thumbnail
      const thumbMatch =
        html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) ||
        html.match(/previewImage:\{uri:"([^"]+)"\}/i);
      const thumbnailUrl = thumbMatch
        ? thumbMatch[1].replace(/&amp;/g, '&').replace(/\\/g, '')
        : 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&auto=format&fit=crop&q=80';

      // Extract video streams using comprehensive regex coverage
      const hdMatch =
        html.match(/browser_native_hd_url:"([^"]+)"/) ||
        html.match(/playable_url_quality_hd:"([^"]+)"/) ||
        html.match(/hd_src:"([^"]+)"/) ||
        html.match(/hd_src_no_ratelimit:"([^"]+)"/) ||
        html.match(/"playable_url_quality_hd":"([^"]+)"/);

      const sdMatch =
        html.match(/browser_native_sd_url:"([^"]+)"/) ||
        html.match(/playable_url:"([^"]+)"/) ||
        html.match(/sd_src:"([^"]+)"/) ||
        html.match(/sd_src_no_ratelimit:"([^"]+)"/) ||
        html.match(/"playable_url":"([^"]+)"/) ||
        html.match(/<meta\s+property="og:video(?::secure_url|:url)?"\s+content="([^"]+)"/i);

      const hdSrc = hdMatch ? hdMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&') : null;
      const sdSrc = sdMatch ? sdMatch[1].replace(/\\/g, '').replace(/&amp;/g, '&') : null;

      const formats: ServerMediaFormat[] = [];
      if (hdSrc) {
        formats.push({
          id: 'fb-hd',
          label: '1080p HD High Definition (MP4)',
          quality: '1080p',
          extension: 'mp4',
          type: 'video',
          recommended: true,
          tier: 'best_quality',
        });
      }
      if (sdSrc) {
        formats.push({
          id: 'fb-sd',
          label: '720p SD Standard (MP4)',
          quality: '720p',
          extension: 'mp4',
          type: 'video',
          tier: 'best_balance',
        });
      }

      if (formats.length === 0) {
        throw new Error('FACEBOOK_SOURCE_NOT_FOUND: لم يتم العثور على رابط فيديو مباشر صالح داخل السورس المقدم.');
      }

      return {
        url: cleanUrl,
        title,
        author: 'Facebook Creator',
        platform: 'facebook',
        category: 'video',
        thumbnailUrl,
        duration: undefined,
        durationSeconds: undefined,
        formats,
      };
    }

    // 2. Direct yt-dlp execution
    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      cleanUrl,
    ];

    try {
      const data = await this.runYtDlpDump(dumpArgs);

      const title = data.title || data.description?.slice(0, 80) || 'Facebook Video';
      const author = data.uploader || 'Facebook Creator';
      const durationSeconds = data.duration || 0;
      const duration = this.formatDuration(durationSeconds);
      const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

      const formats: ServerMediaFormat[] = [];
      const seen = new Set<string>();
      for (const rf of Array.isArray(data.formats) ? data.formats : []) {
        if (!rf || rf.vcodec === 'none' || !rf.height) continue;
        const height = Number(rf.height);
        if (!Number.isFinite(height) || height <= 0) continue;
        const quality = height >= 2160 ? '4K' : height >= 1440 ? '2K' : `${height}p`;
        if (seen.has(quality)) continue;
        seen.add(quality);
        formats.push({ id: `fb-video-${height}`, label: `Available Video (${quality})`, quality, extension: 'mp4', type: 'video', resolution: `${rf.width || '?'}x${height}`, filesizeBytes: rf.filesize || undefined, filesize: rf.filesize ? this.formatBytes(rf.filesize) : undefined });
      }
      this.assignSmartTiers(formats);

      const rawDate = data.upload_date || data.release_date;
      const uploadDate = rawDate && typeof rawDate === 'string' && rawDate.length === 8
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : data.upload_date || (data.timestamp ? new Date(data.timestamp * 1000).toISOString().split('T')[0] : undefined);

      return {
        url: cleanUrl,
        title,
        author,
        authorUrl: data.uploader_url,
        platform: 'facebook',
        category: 'video',
        thumbnailUrl,
        duration,
        durationSeconds,
        uploadDate,
        views: data.view_count ? Number(data.view_count).toLocaleString() : undefined,
        likes: data.like_count ? Number(data.like_count).toLocaleString() : undefined,
        description: data.description,
        formats,
      };
    } catch (dumpErr: any) {
      console.warn('Facebook dump failed, directing to Source Extractor:', dumpErr.message);

      // Meta aggressively restricts scrapers without cookies/session.
      // Explicitly throw FACEBOOK_LOGIN_RESTRICTION to trigger the Private Source Extractor UI
      throw new Error(
        'FACEBOOK_LOGIN_RESTRICTION: فيديوهات فيسبوك محمية بجدار تسجيل دخول ميتا. استخدم "مستخرج فيسبوك المباشر" والصق كود السورس لتنزيله فوراً!'
      );
    }
  }
}
