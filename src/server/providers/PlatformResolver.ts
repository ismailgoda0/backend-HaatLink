import { BaseProvider } from './BaseProvider';
import { YouTubeProvider } from './YouTubeProvider';
import { TikTokProvider } from './TikTokProvider';
import { InstagramProvider } from './InstagramProvider';
import { FacebookProvider } from './FacebookProvider';
import { TwitterProvider } from './TwitterProvider';
import { SoundCloudProvider } from './SoundCloudProvider';
import { RedditProvider } from './RedditProvider';
import { PinterestProvider } from './PinterestProvider';
import { VimeoProvider } from './VimeoProvider';
import { TwitchProvider } from './TwitchProvider';
import { DailymotionProvider } from './DailymotionProvider';
import { GenericMediaProvider } from './GenericMediaProvider';
import { PlatformId, ServerMediaMetadata } from './types';
import { validateUrlForServerAccess } from '../security/ssrfValidator';

export class PlatformResolver {
  private providers: BaseProvider[] = [
    new YouTubeProvider(),
    new TikTokProvider(),
    new InstagramProvider(),
    new FacebookProvider(),
    new TwitterProvider(),
    new SoundCloudProvider(),
    new RedditProvider(),
    new PinterestProvider(),
    new VimeoProvider(),
    new TwitchProvider(),
    new DailymotionProvider(),
    new GenericMediaProvider(),
  ];

  /**
   * Normalizes incoming URLs
   */
  normalizeUrl(rawUrl: string): string {
    let clean = rawUrl.trim();
    // Normalize mobile prefixes e.g., m.youtube.com, mobile.twitter.com
    clean = clean.replace(/^https?:\/\/m\.youtube\.com/i, 'https://www.youtube.com');
    clean = clean.replace(/^https?:\/\/mobile\.twitter\.com/i, 'https://twitter.com');
    return clean;
  }

  /**
   * Detects platform from URL
   */
  detectPlatform(url: string): { platform: PlatformId; isPlaylist: boolean; isShort: boolean } {
    let host = '';
    let pathname = '';
    let search = '';
    try { const parsed = new URL(url); host = parsed.hostname.toLowerCase(); pathname = parsed.pathname.toLowerCase(); search = parsed.search.toLowerCase(); } catch {}
    const has = (...domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));
    if (has('youtube.com','youtu.be')) return { platform:'youtube', isPlaylist: search.includes('list=') || pathname.includes('/playlist'), isShort: pathname.includes('/shorts/') };
    if (has('tiktok.com','douyin.com')) return { platform:'tiktok', isPlaylist:false, isShort:true };
    if (has('instagram.com','instagr.am')) return { platform:'instagram', isPlaylist:false, isShort: pathname.includes('/reel') || pathname.includes('/stories') };
    if (has('facebook.com','fb.watch','fb.com')) return { platform:'facebook', isPlaylist:false, isShort: pathname.includes('/reel') };
    if (has('twitter.com','x.com')) return { platform:'twitter', isPlaylist:false, isShort:false };
    if (has('soundcloud.com')) return { platform:'soundcloud', isPlaylist: pathname.includes('/sets/'), isShort:false };
    if (has('reddit.com','redd.it')) return { platform:'reddit', isPlaylist:false, isShort:false };
    if (has('pinterest.com','pin.it')) return { platform:'pinterest', isPlaylist:false, isShort:false };
    if (has('vimeo.com')) return { platform:'vimeo', isPlaylist:false, isShort:false };
    if (has('twitch.tv')) return { platform:'twitch', isPlaylist:false, isShort:false };
    if (has('dailymotion.com','dai.ly')) return { platform:'dailymotion', isPlaylist:false, isShort:false };
    return { platform:'generic', isPlaylist:false, isShort:false };
  }

  /**
   * Resolves media metadata using registered providers
   */
  async resolve(url: string, rawHtml?: string): Promise<ServerMediaMetadata> {
    const cleanUrl = this.normalizeUrl(url);

    // SSRF Security check
    const safety = await validateUrlForServerAccess(cleanUrl);
    if (!safety.safe) {
      throw new Error(`Invalid or prohibited URL: ${safety.error}`);
    }

    // Select by validated hostname rather than substring matching.
    const detected = this.detectPlatform(cleanUrl);
    const provider = this.providers.find((p) => p.platform === detected.platform) ||
      (detected.platform === 'generic' ? this.providers.find((p) => p instanceof GenericMediaProvider) : undefined);
    if (provider) {
      return await provider.resolve(cleanUrl, rawHtml);
    }

    // Fallback: try generic media provider if URL could be direct stream
    const genericProvider = this.providers.find((p) => p instanceof GenericMediaProvider);
    if (genericProvider) {
      try {
        return await genericProvider.resolve(cleanUrl);
      } catch {
        // Continue to unsupported error
      }
    }

    throw new Error('UNSUPPORTED_PLATFORM: المنصة دي مش مدعومة حاليًا | This platform is not currently supported.');
  }
}

export const platformResolver = new PlatformResolver();
