import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat, ServerPlaylistItem } from './types';

export class SoundCloudProvider extends BaseProvider {
  readonly platform: PlatformId = 'soundcloud';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('soundcloud.com');
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();

    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      '--flat-playlist',
      cleanUrl,
    ];

    try {
      const data = await this.runYtDlpDump(dumpArgs);

      // Playlist / Set
      if (data._type === 'playlist' || (Array.isArray(data.entries) && data.entries.length > 0)) {
        const entries: any[] = data.entries || [];
        const playlistItems: ServerPlaylistItem[] = entries.map((entry: any, index: number) => {
          const itemDurationSec = entry.duration || 0;
          return {
            id: entry.id || `sc-${index + 1}`,
            index: index + 1,
            title: entry.title || `Track ${index + 1}`,
            author: entry.uploader || data.uploader || 'SoundCloud Artist',
            duration: this.formatDuration(itemDurationSec),
            durationSeconds: itemDurationSec,
            thumbnailUrl: entry.thumbnail || data.thumbnail || '',
            url: entry.url || cleanUrl,
            filesizeEst: itemDurationSec ? this.formatBytes(itemDurationSec * 40000) : undefined,
            selected: true,
          };
        });

        const totalDurationSec = playlistItems.reduce((acc, curr) => acc + curr.durationSeconds, 0);

        return {
          url: cleanUrl,
          title: data.title || 'SoundCloud Album / Playlist',
          author: data.uploader || 'SoundCloud Artist',
          authorUrl: data.uploader_url,
          platform: 'soundcloud',
          category: 'playlist',
          thumbnailUrl: data.thumbnail || (playlistItems[0]?.thumbnailUrl) || '',
          duration: this.formatDuration(totalDurationSec),
          durationSeconds: totalDurationSec,
          formats: [
            {
              id: 'sc-mp3-320',
              label: 'MP3 High Quality (320kbps Audio)',
              quality: '320k',
              extension: 'mp3',
              type: 'audio',
              recommended: true,
            },
            {
              id: 'sc-m4a-256',
              label: 'M4A Original (256kbps Audio)',
              quality: '256k',
              extension: 'm4a',
              type: 'audio',
            },
          ],
          playlist: {
            title: data.title || 'SoundCloud Playlist',
            totalItems: playlistItems.length,
            totalDuration: this.formatDuration(totalDurationSec),
            items: playlistItems,
          },
        };
      }

      const title = data.title || 'SoundCloud Track';
      const author = data.uploader || 'SoundCloud Artist';
      const durationSeconds = data.duration || 0;
      const duration = this.formatDuration(durationSeconds);
      const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

      const formats: ServerMediaFormat[] = [
        {
          id: 'sc-mp3-320',
          label: 'Ultra MP3 Audio (320kbps)',
          quality: '320k',
          extension: 'mp3',
          type: 'audio',
          bitrate: '320 kbps',
          recommended: true,
          tier: 'best_quality',
          filesize: durationSeconds ? this.formatBytes(durationSeconds * 40000) : undefined,
        },
        {
          id: 'sc-m4a-256',
          label: 'M4A High Definition (256kbps)',
          quality: '256k',
          extension: 'm4a',
          type: 'audio',
          bitrate: '256 kbps',
          tier: 'best_balance',
          filesize: durationSeconds ? this.formatBytes(durationSeconds * 32000) : undefined,
        },
        {
          id: 'sc-wav-lossless',
          label: 'Studio WAV (Lossless PCM)',
          quality: 'Lossless',
          extension: 'wav',
          type: 'audio',
          tier: 'smallest_size',
        },
      ];

      return {
        url: cleanUrl,
        title,
        author,
        authorUrl: data.uploader_url,
        platform: 'soundcloud',
        category: 'audio',
        thumbnailUrl,
        duration,
        durationSeconds,
        uploadDate: data.upload_date ? `${data.upload_date.slice(0, 4)}-${data.upload_date.slice(4, 6)}-${data.upload_date.slice(6, 8)}` : undefined,
        likes: data.like_count ? Number(data.like_count).toLocaleString() : undefined,
        description: data.description,
        formats,
      };
    } catch (dumpErr: any) {
      console.warn('SoundCloud dump failed, trying oEmbed fallback:', dumpErr.message);

      try {
        const oembedRes = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(cleanUrl)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HaatLinkBot/1.0)' },
        });

        if (oembedRes.ok) {
          const oembed = (await oembedRes.json()) as Record<string, unknown>;
          const title = oembed.title as string | undefined || 'SoundCloud Track';
          const author = oembed.author_name as string | undefined || 'SoundCloud Artist';
          const authorUrl = oembed.author_url as string | undefined;
          const thumbnailUrl = oembed.thumbnail_url as string | undefined || '';

          const formats: ServerMediaFormat[] = [
            {
              id: 'sc-mp3-320',
              label: 'Ultra MP3 Audio (320kbps)',
              quality: '320k',
              extension: 'mp3',
              type: 'audio',
              bitrate: '320 kbps',
              recommended: true,
              tier: 'best_quality',
            },
            {
              id: 'sc-m4a-256',
              label: 'M4A High Definition (256kbps)',
              quality: '256k',
              extension: 'm4a',
              type: 'audio',
              bitrate: '256 kbps',
              tier: 'best_balance',
            },
            {
              id: 'sc-wav-lossless',
              label: 'Studio WAV (Lossless Audio)',
              quality: 'Lossless',
              extension: 'wav',
              type: 'audio',
              tier: 'smallest_size',
            },
          ];

          return {
            url: cleanUrl,
            title,
            author,
            authorUrl,
            platform: 'soundcloud',
            category: 'audio',
            thumbnailUrl,
            duration: '04:15',
            durationSeconds: 255,
            description: oembed.description as string | undefined,
            formats,
          };
        }
      } catch {
        // pass through to original error
      }

      throw dumpErr;
    }
  }
}
