import dotenv from 'dotenv';

dotenv.config();

function number(name: string, fallback: number, options: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (options.min !== undefined && value < options.min) throw new Error(`${name} must be >= ${options.min}`);
  if (options.max !== undefined && value > options.max) throw new Error(`${name} must be <= ${options.max}`);
  return value;
}

function string(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

export const config = Object.freeze({
  nodeEnv: string('NODE_ENV', 'development'),
  port: number('PORT', 3000, { min: 1, max: 65535 }),
  host: string('HOST', '0.0.0.0'),
  trustProxyHops: number('TRUST_PROXY_HOPS', 1, { min: 0, max: 20 }),
  frontendOrigin: string('FRONTEND_ORIGIN', 'http://localhost:5173,https://haat-link.web.app'),
  sessionSecret: string('SESSION_SECRET'),
  geminiApiKey: string('GEMINI_API_KEY') || string('GOOGLE_API_KEY'),
  googleApiKey: string('GOOGLE_API_KEY'),
  geminiPrimaryModel: string('GEMINI_PRIMARY_MODEL', 'gemini-3.8-flash'),
  geminiFallbackModels: string('GEMINI_FALLBACK_MODELS', 'gemini-3.5-flash-lite,gemini-2.5-flash-lite,gemini-3.6-flash')
    .split(',').map((v) => v.trim()).filter(Boolean),

  apiRateLimit: number('API_RATE_LIMIT', 30, { min: 1 }),
  heavyRateLimit: number('HEAVY_RATE_LIMIT', 8, { min: 1 }),
  streamRateLimit: number('STREAM_RATE_LIMIT', 12, { min: 1 }),
  aiRateLimit: number('AI_RATE_LIMIT', 10, { min: 1 }),
  aiDailyQuota: number('AI_DAILY_QUOTA', 100, { min: 1 }),

  maxRequestBody: string('MAX_REQUEST_BODY', '2mb'),
  maxBatchItems: number('MAX_BATCH_ITEMS', 10, { min: 1, max: 100 }),
  maxBatchTotalBytes: number('MAX_BATCH_TOTAL_BYTES', 500 * 1024 * 1024, { min: 1 }),
  maxRangeSeconds: number('MAX_RANGE_SECONDS', 4 * 60 * 60, { min: 1 }),
  maxStreamBytes: number('MAX_STREAM_BYTES', 500 * 1024 * 1024, { min: 1 }),
  maxHtmlBytes: number('MAX_HTML_BYTES', 2 * 1024 * 1024, { min: 1 }),
  maxTranscriptBytes: number('MAX_TRANSCRIPT_BYTES', 2 * 1024 * 1024, { min: 1 }),
  maxDownloadBytes: number('MAX_DOWNLOAD_BYTES', 2 * 1024 * 1024 * 1024, { min: 1 }),

  maxConcurrentDownloads: number('MAX_CONCURRENT_DOWNLOADS', 4, { min: 1, max: 32 }),
  maxConcurrentPerUser: number('MAX_CONCURRENT_PER_USER', 2, { min: 1, max: 16 }),
  maxQueueSize: number('MAX_QUEUE_SIZE', 50, { min: 1, max: 1000 }),
  jobTtlMs: number('JOB_TTL_MS', 60 * 60 * 1000, { min: 60_000 }),

  previewMaxHeight: number('PREVIEW_MAX_HEIGHT', 720, { min: 144, max: 4320 }),
  ytdlpSocketTimeout: string('YTDLP_SOCKET_TIMEOUT', '25'),
  ytdlpRetries: string('YTDLP_RETRIES', '2'),
  ytdlpPath: string('YT_DLP_PATH'),
  ffmpegPath: string('FFMPEG_PATH'),

  tempDir: string('HAAT_TEMP_DIR'),
  serverCacheDir: string('HAAT_SERVER_CACHE_DIR'),
  maxCacheSizeBytes: number('MAX_CACHE_SIZE_BYTES', 5 * 1024 * 1024 * 1024, { min: 1 }),
  maxCacheItems: number('MAX_CACHE_ITEMS', 100, { min: 1 }),
  maxCacheItemBytes: number('MAX_CACHE_ITEM_BYTES', 1024 * 1024 * 1024, { min: 1 }),
  maxCacheAudioBytes: number('MAX_CACHE_AUDIO_BYTES', 100 * 1024 * 1024, { min: 1 }),
  cacheItemTtlMs: number('CACHE_ITEM_TTL_MS', 7 * 24 * 60 * 60 * 1000, { min: 60_000 }),
  cacheDownloadTimeoutMs: number('CACHE_DOWNLOAD_TIMEOUT_MS', 15 * 60 * 1000, { min: 60_000 }),
  cacheAudioTimeoutMs: number('CACHE_AUDIO_TIMEOUT_MS', 5 * 60 * 1000, { min: 60_000 }),
  downloadTimeoutMs: number('DOWNLOAD_TIMEOUT_MS', 20 * 60 * 1000, { min: 60_000 }),
});

export type HaatConfig = typeof config;
