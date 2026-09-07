import { BaseProvider } from './BaseProvider';
import { PlatformId, ServerMediaMetadata, ServerMediaFormat, ServerPlaylistItem } from './types';

export class YouTubeProvider extends BaseProvider {
  readonly platform: PlatformId = 'youtube';

  canHandle(url: string): boolean {
    const u = url.toLowerCase();
    return u.includes('youtube.com') || u.includes('youtu.be');
  }

  private extractVideoId(url: string): string | null {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{11})/i);
    return match ? match[1] : null;
  }

  async resolve(url: string): Promise<ServerMediaMetadata> {
    const cleanUrl = url.trim();
    const isPlaylist = cleanUrl.includes('list=') || cleanUrl.includes('/playlist');

    // Run yt-dlp to dump JSON
    const dumpArgs = [
      '--dump-single-json',
      '--no-warnings',
      '--flat-playlist',
      '--playlist-end', '50',
      cleanUrl,
    ];

    try {
      const data = await this.runYtDlpDump(dumpArgs);

      // Check if it returned a playlist
      if (data._type === 'playlist' || (Array.isArray(data.entries) && data.entries.length > 0)) {
        const entries: any[] = data.entries || [];
        const playlistItems: ServerPlaylistItem[] = entries.map((entry: any, index: number) => {
          const itemDurationSec = entry.duration || 0;
          return {
            id: entry.id || `yt-${index + 1}`,
            index: index + 1,
            title: entry.title || `Track ${index + 1}`,
            author: entry.uploader || entry.channel || data.uploader || 'YouTube Creator',
            duration: this.formatDuration(itemDurationSec),
            durationSeconds: itemDurationSec,
            thumbnailUrl: entry.thumbnail || (entry.thumbnails && entry.thumbnails[0]?.url) || data.thumbnail || '',
            url: entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : cleanUrl),
            filesizeEst: itemDurationSec ? this.formatBytes(itemDurationSec * 600000) : undefined,
            selected: true,
          };
        });

        const totalDurationSec = playlistItems.reduce((acc, curr) => acc + curr.durationSeconds, 0);

        return {
          url: cleanUrl,
          title: data.title || 'YouTube Playlist',
          author: data.uploader || data.channel || 'YouTube Curator',
          authorUrl: data.uploader_url || data.channel_url,
          platform: 'youtube',
          category: 'playlist',
          thumbnailUrl: data.thumbnail || (playlistItems[0]?.thumbnailUrl) || '',
          duration: this.formatDuration(totalDurationSec),
          durationSeconds: totalDurationSec,
          views: data.view_count ? Number(data.view_count).toLocaleString() : undefined,
          formats: [
            {
              id: 'audio-mp3-320',
              label: 'MP3 High Quality (320kbps Audio)',
              quality: '320k',
              extension: 'mp3',
              type: 'audio',
              recommended: true,
            },
            {
              id: 'video-mp4-720',
              label: 'MP4 720p HD (Balanced Video)',
              quality: '720p',
              extension: 'mp4',
              type: 'video',
            },
          ],
          playlist: {
            title: data.title || 'YouTube Playlist',
            totalItems: playlistItems.length,
            totalDuration: this.formatDuration(totalDurationSec),
            items: playlistItems,
          },
        };
      }

      // Single Video processing
      const title = data.title || 'YouTube Media';
      const author = data.uploader || data.channel || 'YouTube Creator';
      const durationSeconds = data.duration || 0;
      const duration = this.formatDuration(durationSeconds);
      const thumbnailUrl = data.thumbnail || (data.thumbnails && data.thumbnails[data.thumbnails.length - 1]?.url) || '';

      // Keep the complete yt-dlp format matrix. Do not deduplicate by quality:
      // 1080p can legitimately have multiple codecs, FPS values, containers,
      // HDR variants and audio/progressive variants.
      const rawFormats: any[] = Array.isArray(data.formats) ? data.formats : [];
      const formats: ServerMediaFormat[] = [];
      const seenSourceIds = new Set<string>();

      const qualityLabel = (height: number, width = 0): string => {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '2K';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height >= 360) return '360p';
        if (height >= 240) return '240p';
        if (height > 0) return `${height}p`;
        return width > 0 ? `${width}w` : 'Original';
      };
      const sizeOf = (rf: any): number | undefined => {
        const n = Number(rf.filesize || rf.filesize_approx || 0);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const codec = (value: any): string => String(value || '').split('.')[0] || 'unknown';
      const codecLabel = (value: string): string => {
        if (value === 'av01') return 'AV1';
        if (value === 'vp9') return 'VP9';
        if (value === 'avc1') return 'H.264';
        if (value === 'vp8') return 'VP8';
        return value.toUpperCase();
      };

      for (const rf of rawFormats) {
        const sourceId = String(rf.format_id || '').trim();
        if (!sourceId || seenSourceIds.has(sourceId)) continue;
        const hasVideo = Boolean(rf.vcodec && rf.vcodec !== 'none');
        const hasAudio = Boolean(rf.acodec && rf.acodec !== 'none');
        if (!hasVideo && !hasAudio) continue;

        seenSourceIds.add(sourceId);
        const ext = String(rf.ext || '').toLowerCase();
        const height = Number(rf.height || 0);
        const width = Number(rf.width || 0);
        const fps = Number(rf.fps || 0);
        const vcodec = codec(rf.vcodec);
        const acodec = codec(rf.acodec);
        const note = String(rf.format_note || '').trim();
        const dynamicRange = String(rf.dynamic_range || '').trim();
        const protocol = String(rf.protocol || '').split('.')[0];
        const sizeBytes = sizeOf(rf);

        if (hasVideo) {
          const quality = qualityLabel(height, width);
          const displayExt = ext === 'webm' ? 'webm' : 'mp4';
          const details = [
            quality,
            width && height ? `${width}×${height}` : '',
            fps > 0 ? `${Math.round(fps)}fps` : '',
            codecLabel(vcodec),
            hasAudio ? `صوت ${codecLabel(acodec)}` : 'فيديو فقط',
            dynamicRange && dynamicRange !== 'SDR' ? dynamicRange : '',
            note && !/^\d+p$/i.test(note) ? note : '',
          ].filter(Boolean);
          formats.push({
            id: `video-source-${sourceId}`,
            label: `${displayExt.toUpperCase()} • ${details.join(' • ')}`,
            quality, resolution: width && height ? `${width}x${height}` : undefined,
            extension: displayExt as 'mp4' | 'webm', type: 'video',
            filesize: sizeBytes ? this.formatBytes(sizeBytes) : undefined, filesizeBytes: sizeBytes,
            fps: fps > 0 ? fps : undefined, hasAudio, sourceFormatId: sourceId, sourceExtension: ext || undefined,
            videoCodec: vcodec, audioCodec: hasAudio ? acodec : undefined, formatNote: note || undefined,
            protocol: protocol || undefined, dynamicRange: dynamicRange || undefined,
          });
        } else {
          const bitrate = Number(rf.tbr || rf.abr || 0);
          const audioQuality = bitrate > 0 ? `${Math.round(bitrate)}k` : 'Original';
          const audioOutput = ext === 'webm' ? 'webm' : 'm4a';
          const details = [audioQuality, codecLabel(acodec), ext.toUpperCase(), note].filter(Boolean);
          formats.push({
            id: `audio-source-${sourceId}`, label: `${ext ? ext.toUpperCase() : 'AUDIO'} • ${details.join(' • ')}`,
            quality: audioQuality, extension: audioOutput as 'm4a' | 'webm', type: 'audio',
            bitrate: bitrate > 0 ? `${Math.round(bitrate)} kbps` : undefined,
            filesize: sizeBytes ? this.formatBytes(sizeBytes) : undefined, filesizeBytes: sizeBytes,
            sourceFormatId: sourceId, sourceExtension: ext || undefined, audioCodec: acodec,
            formatNote: note || undefined, protocol: protocol || undefined,
          });
        }
      }

      const estimatedAudioSize = (kbps: number) => durationSeconds > 0 ? this.formatBytes(durationSeconds * kbps * 125) : undefined;
      formats.push(
        { id: 'audio-convert-mp3-320', label: 'MP3 • 320 kbps • تحويل عالي الجودة', quality: '320k', extension: 'mp3', type: 'audio', bitrate: '320 kbps', filesize: estimatedAudioSize(320) },
        { id: 'audio-convert-mp3-256', label: 'MP3 • 256 kbps', quality: '256k', extension: 'mp3', type: 'audio', bitrate: '256 kbps', filesize: estimatedAudioSize(256) },
        { id: 'audio-convert-m4a-256', label: 'M4A • 256 kbps • AAC', quality: '256k', extension: 'm4a', type: 'audio', bitrate: '256 kbps', filesize: estimatedAudioSize(256) },
        { id: 'audio-convert-wav', label: 'WAV • PCM • بدون ضغط', quality: 'Lossless', extension: 'wav', type: 'audio' },
      );

      this.assignSmartTiers(formats);

      const rawDate = data.upload_date || data.release_date;
      const uploadDate = rawDate && typeof rawDate === 'string' && rawDate.length === 8
        ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
        : data.upload_date || (data.timestamp ? new Date(data.timestamp * 1000).toISOString().split('T')[0] : undefined);

      const subtitles: { language: string; langCode: string; format: 'srt' | 'vtt'; isAutoGenerated: boolean; url?: string }[] = [];
      const manualSubs = data.subtitles || {};
      const autoSubs = data.automatic_captions || {};
      const allSubs = { ...manualSubs, ...autoSubs };
      for (const [lang, subFormats] of Object.entries(allSubs)) {
        if (!Array.isArray(subFormats) || subFormats.length === 0) continue;
        const candidates = subFormats.filter((f: any) => ['vtt', 'srt'].includes(String(f.ext || '').toLowerCase()));
        const match = candidates.find((f: any) => String(f.ext).toLowerCase() === 'vtt') || candidates[0] || subFormats[0];
        if (!match) continue;
        subtitles.push({
          language: lang.toUpperCase(), langCode: lang,
          format: String(match.ext).toLowerCase() === 'srt' ? 'srt' : 'vtt',
          isAutoGenerated: Boolean(!manualSubs[lang] && autoSubs[lang]), url: match.url,
        });
      }
      subtitles.sort((a, b) => Number(a.isAutoGenerated) - Number(b.isAutoGenerated) || a.language.localeCompare(b.language));

      return {
        url: cleanUrl,
        title,
        author,
        authorUrl: data.uploader_url || data.channel_url,
        platform: 'youtube',
        category: 'video',
        thumbnailUrl,
        duration,
        durationSeconds,
        uploadDate,
        views: data.view_count ? Number(data.view_count).toLocaleString() : undefined,
        likes: data.like_count ? Number(data.like_count).toLocaleString() : undefined,
        description: data.description,
        subtitles: subtitles.length > 0 ? subtitles : undefined,
        formats,
      };
    } catch (dumpErr: any) {
      console.warn('YouTube yt-dlp dump failed, trying official oEmbed fallback:', dumpErr.message);

      // Fallback: YouTube oEmbed API
      const videoId = this.extractVideoId(cleanUrl);
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });

      if (!oembedRes.ok) {
        throw dumpErr; // Throw original error if even oembed fails
      }

      const oembed = (await oembedRes.json()) as Record<string, unknown>;
      const title = oembed.title as string | undefined || 'YouTube Video';
      const author = oembed.author_name as string | undefined || 'YouTube Creator';
      const authorUrl = oembed.author_url as string | undefined;
      const thumbnailUrl = oembed.thumbnail_url as string | undefined || (videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : '');

      return {
        url: cleanUrl,
        title,
        author,
        authorUrl,
        platform: 'youtube',
        category: 'video',
        thumbnailUrl,
        // oEmbed is metadata-only, but keep the download UI usable when
        // yt-dlp is temporarily unavailable. The actual download engine
        // resolves the requested quality server-side.
        duration: undefined,
        durationSeconds: undefined,
        formats: [
          {
            id: 'yt-1080p-fallback',
            label: 'MP4 Full HD (1080p)',
            quality: '1080p',
            extension: 'mp4',
            type: 'video',
            recommended: true,
            tier: 'best_quality',
          },
          {
            id: 'yt-720p-fallback',
            label: 'MP4 HD (720p)',
            quality: '720p',
            extension: 'mp4',
            type: 'video',
            tier: 'best_balance',
          },
          {
            id: 'yt-480p-fallback',
            label: 'MP4 Standard (480p)',
            quality: '480p',
            extension: 'mp4',
            type: 'video',
            tier: 'smallest_size',
          },
          {
            id: 'yt-mp3-fallback',
            label: 'MP3 Audio (320kbps)',
            quality: '320k',
            extension: 'mp3',
            type: 'audio',
          },
          {
            id: 'yt-m4a-fallback',
            label: 'Original Audio (M4A)',
            quality: '256k',
            extension: 'm4a',
            type: 'audio',
          },
        ],
      };
    }
  }
}
