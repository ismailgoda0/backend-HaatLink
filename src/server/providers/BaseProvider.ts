import { PlatformId, ServerMediaMetadata, ServerMediaFormat } from './types';
import path from 'path';
import { validateUrlForServerAccess } from '../security/ssrfValidator';
import { spawnYtDlp } from '../utils/binaryHelper';

export abstract class BaseProvider {
  abstract readonly platform: PlatformId;
  abstract canHandle(url: string): boolean;
  abstract resolve(url: string, rawHtml?: string): Promise<ServerMediaMetadata>;

  /**
   * Helper to execute yt-dlp safely with JSON output
   */
  protected async runYtDlpDump(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      // Inject standard browser headers & timeout if not explicitly present
      const finalArgs = ['--ignore-config', ...args];
      const candidateUrl = [...finalArgs].reverse().find((arg) => /^https?:\/\//i.test(arg));
      if (candidateUrl) {
        validateUrlForServerAccess(candidateUrl).then((check) => {
          if (!check.safe) return reject(new Error(`Invalid or prohibited URL: ${check.error}`));
          this.spawnYtDlp(finalArgs, resolve, reject);
        }).catch(() => reject(new Error('Unable to validate target URL safely')));
        return;
      }
      this.spawnYtDlp(finalArgs, resolve, reject);
    });
  }

  private spawnYtDlp(finalArgs: string[], resolve: (value: any) => void, reject: (reason?: any) => void) {
      if (!finalArgs.includes('--user-agent')) {
        finalArgs.unshift(
          '--user-agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        );
      }
      if (!finalArgs.includes('--socket-timeout')) {
        finalArgs.unshift('--socket-timeout', '25');
      }
      const child = spawnYtDlp(finalArgs, {
        timeout: 35000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          try {
            // yt-dlp may output warning lines before JSON; grab first valid JSON block
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              if (line.startsWith('{')) {
                const parsed = JSON.parse(line);
                return resolve(parsed);
              }
            }
            // fallback: parse whole string
            const parsed = JSON.parse(stdout.trim());
            return resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse yt-dlp JSON output: ${stdout.slice(0, 200)}`));
          }
        } else {
          // Standardize error classification
          const cleanErr = stderr.trim();
          if (cleanErr.includes('404') || cleanErr.includes('Not Found') || cleanErr.includes('does not exist')) {
            return reject(new Error('MEDIA_NOT_FOUND: المحتوى غير موجود أو تم حذفه من المنصة الأصلية | Media not found or removed.'));
          }
          if (cleanErr.includes('Private video') || cleanErr.includes('This video is private')) {
            return reject(new Error('PRIVATE_MEDIA: المحتوى ده خاص أو مقفول من صاحبه | This media is private.'));
          }
          if (cleanErr.includes('Video unavailable') || cleanErr.includes('not available')) {
            return reject(new Error('MEDIA_NOT_FOUND: المحتوى غير متوفر حالياً | Media is unavailable.'));
          }
          if (cleanErr.includes('Sign in to confirm you’re not a bot') || cleanErr.includes('Sign in') || cleanErr.includes('login required')) {
            return reject(new Error('LOGIN_REQUIRED: المحتوى يتطلب تسجيل دخول أو تحقق أمني | Login or bot check required.'));
          }
          if (cleanErr.includes('Cannot parse data')) {
            return reject(new Error('CANNOT_PARSE_DATA: تعذر استخراج بيانات الوسائط من المنصة | Unable to parse platform media streams.'));
          }
          reject(new Error(cleanErr || `yt-dlp failed with exit code ${code}`));
        }
      });

      child.on('error', (err) => { reject(err); });
    }

  /**
   * Format seconds to HH:MM:SS or MM:SS
   */
  protected formatDuration(seconds?: number): string {
    if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
    const s = Math.round(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Format bytes to human-readable string
   */
  protected formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0 || isNaN(bytes)) return 'Unknown size';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * Helper to tag Smart Recommendations (Best Quality, Best Balance, Smallest Size)
   */
  protected assignSmartTiers(formats: ServerMediaFormat[]): ServerMediaFormat[] {
    const videoFormats = formats.filter((f) => f.type === 'video');
    if (videoFormats.length === 0) return formats;

    // Sort by resolution/bitrate or quality descending
    const qualityRank: Record<string, number> = {
      '4K': 2160,
      '2K': 1440,
      '1080p': 1080,
      '720p': 720,
      '480p': 480,
      '360p': 360,
      '240p': 240,
      '144p': 144,
    };

    const sorted = [...videoFormats].sort((a, b) => {
      const rankA = qualityRank[a.quality] || 0;
      const rankB = qualityRank[b.quality] || 0;
      return rankB - rankA;
    });

    if (sorted.length > 0) {
      // Best quality: top video
      sorted[0].tier = 'best_quality';
      sorted[0].recommended = true;
    }

    if (sorted.length >= 2) {
      // Best balance: around 1080p or 720p or middle
      const middleIdx = Math.floor(sorted.length / 2);
      const balanceCandidate = sorted.find((f) => f.quality === '1080p' || f.quality === '720p') || sorted[middleIdx];
      if (balanceCandidate && balanceCandidate !== sorted[0]) {
        balanceCandidate.tier = 'best_balance';
      }
    }

    if (sorted.length >= 3) {
      // Smallest size: bottom video
      const smallest = sorted[sorted.length - 1];
      if (smallest && !smallest.tier) {
        smallest.tier = 'smallest_size';
      }
    }

    return formats;
  }
}
