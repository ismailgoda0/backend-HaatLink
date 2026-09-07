interface Env {
  SESSION_SECRET: string;
  GEMINI_API_KEY?: string;
  FRONTEND_ORIGIN?: string;
  GEMINI_PRIMARY_MODEL?: string;
  GEMINI_FALLBACK_MODELS?: string;
  MEDIA_RESOLVER_URL?: string;
  MEDIA_RESOLVER_TOKEN?: string;
  API_RATE_LIMIT?: string;
  AI_RATE_LIMIT?: string;
  AI_DAILY_QUOTA?: string;
  MAX_DOWNLOAD_BYTES?: string;
  MAX_HTML_BYTES?: string;
  MAX_STREAM_BYTES?: string;
}

const VERSION = '0.3-free-worker';
const DEFAULT_ORIGINS = [
  'https://haat-link.web.app',
  'https://haat-link.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const memoryRate = new Map<string, { count: number; resetAt: number }>();

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;

  // Keep the production Firebase origins allowed even if FRONTEND_ORIGIN
  // is missing/misconfigured in the Cloudflare dashboard.
  const configured = String(env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ORIGINS, ...configured])].includes(origin)
    ? origin
    : null;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  const origin = allowedOrigin(request, env);

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Range, X-Haat-Client, Authorization'
    );
    headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, X-Haat-Worker'
    );
    headers.set('Access-Control-Max-Age', '86400');
    headers.append('Vary', 'Origin');
  }

  headers.set('X-Haat-Worker', 'cloudflare-free');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(payload: unknown, request: Request, env: Env, status = 200): Response {
  return withCors(new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  }), request, env);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(value: string, secret: string, usage: 'sign' | 'verify' = 'sign'): Promise<string | boolean> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  if (usage === 'verify') return crypto.subtle.verify('HMAC', key, base64UrlToBytes(value.split('.')[1] || ''), encoder.encode(value.split('.')[0] || ''));
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function createSession(env: Env): Promise<string> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const id = base64Url(random);
  const signature = await hmac(id, env.SESSION_SECRET) as string;
  return `${id}.${signature}`;
}

async function validSession(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)haat_session=([^;]+)/);
  if (!match?.[1]) return false;
  let value = '';
  try { value = decodeURIComponent(match[1]); } catch { return false; }
  if (!value.includes('.') || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return false;
  try { return Boolean(await hmac(value, env.SESSION_SECRET, 'verify')); } catch { return false; }
}

function sessionResponse(request: Request, env: Env): Promise<Response> {
  return (async () => {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ success: false, code: 'SESSION_SECRET_MISSING' }, request, env, 503);
    if (await validSession(request, env)) return json({ success: true }, request, env);
    const value = await createSession(env);
    const response = new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': `haat_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000`,
      },
    });
    return withCors(response, request, env);
  })();
}

function clientKey(request: Request): string {
  const explicit = request.headers.get('X-Haat-Client');
  if (explicit && explicit.length >= 8) return explicit;
  const query = new URL(request.url).searchParams.get('haat_client');
  if (query && query.length >= 8) return query;
  return request.headers.get('CF-Connecting-IP') || 'anonymous';
}

function rateLimit(request: Request, env: Env, bucket: string, limit: number): Response | null {
  if (!limit || limit <= 0) return null;
  const now = Date.now();
  const key = `${bucket}:${clientKey(request)}`;
  const current = memoryRate.get(key);
  if (!current || current.resetAt <= now) {
    memoryRate.set(key, { count: 1, resetAt: now + 60_000 });
    return null;
  }
  current.count += 1;
  if (current.count > limit) return json({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }, request, env, 429);
  return null;
}

function safeTarget(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1' || host === '[::1]') return null;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return null;
    if (host === 'metadata.google.internal' || host.endsWith('.internal')) return null;
    return url;
  } catch { return null; }
}

async function readBody(request: Request, maxBytes = 2_000_000): Promise<any> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Request body is too large');
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('Request body is too large');
  return text ? JSON.parse(text) : {};
}

function htmlEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractDirectMedia(html: string, pageUrl: string) {
  const found = new Set<string>();
  const add = (raw: string) => {
    try {
      const value = htmlEntities(raw).replace(/\\/g, '');
      const absolute = new URL(value, pageUrl);
      if (['http:', 'https:'].includes(absolute.protocol)) found.add(absolute.toString());
    } catch {}
  };

  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:video|og:video:url|og:video:secure_url|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi,
    /<(?:video|audio|source)[^>]+src=["']([^"']+)["']/gi,
    /(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|hd_src|sd_src)["']?\s*:\s*["']([^"']+)["']/gi,
    /https?:\/\/[^\s"'<>]+?\.(?:mp4|webm|m3u8|mp3|m4a|wav)(?:\?[^\s"'<>]*)?/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) add(match[1] || match[0]);
  }

  return [...found].slice(0, 50);
}

function platformOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
  if (host.includes('tiktok.com')) return 'tiktok';
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('facebook.com') || host.includes('fb.watch')) return 'facebook';
  if (host.includes('twitter.com') || host.includes('x.com')) return 'twitter';
  if (host.includes('soundcloud.com')) return 'soundcloud';
  if (host.includes('vimeo.com')) return 'vimeo';
  if (host.includes('reddit.com')) return 'reddit';
  if (host.includes('pinterest.')) return 'pinterest';
  if (host.includes('twitch.tv')) return 'twitch';
  if (host.includes('dailymotion.com') || host.includes('dai.ly')) return 'dailymotion';
  return 'generic';
}

async function oembed(url: string, platform: string): Promise<any> {
  const endpoints: Record<string, string> = {
    youtube: `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    tiktok: `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
    vimeo: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
    soundcloud: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  };
  const endpoint = endpoints[platform];
  if (!endpoint) return {};
  try {
    const response = await fetch(endpoint, { headers: { 'User-Agent': 'HaatLink/0.3' } });
    if (!response.ok) return {};
    return await response.json();
  } catch { return {}; }
}

function formatsFromUrls(urls: string[]) {
  return urls.map((url, index) => {
    const pathname = new URL(url).pathname.toLowerCase();
    const audio = /\.(mp3|m4a|wav|aac|ogg|opus)$/.test(pathname);
    const ext = pathname.match(/\.(mp4|webm|mp3|m4a|wav|aac|ogg|opus)$/)?.[1] || (audio ? 'mp3' : 'mp4');
    return {
      id: `direct-${index + 1}`,
      label: audio ? `Audio ${ext.toUpperCase()}` : `Direct ${ext.toUpperCase()}`,
      quality: 'source',
      extension: ext === 'webm' ? 'webm' : audio ? (ext === 'm4a' ? 'm4a' : ext === 'wav' ? 'wav' : 'mp3') : 'mp4',
      type: audio ? 'audio' : 'video',
      hasAudio: true,
      recommended: index === 0,
      url,
    };
  });
}

async function edgeResolve(url: string, rawHtml?: string) {
  const platform = platformOf(url);
  let html = rawHtml || '';
  if (!html) {
    const target = safeTarget(url);
    if (!target) throw new Error('Unsafe or invalid URL');
    const response = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HaatLink/FreeWorker)' },
    });
    if (!response.ok) throw new Error(`Unable to fetch source page (${response.status})`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2_000_000) throw new Error('Source HTML is too large');
    html = await response.text();
    if (html.length > 2_000_000) throw new Error('Source HTML is too large');
  }

  const metaTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const metaDescription = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const thumbnail = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
  const embed = await oembed(url, platform);
  const directUrls = extractDirectMedia(html, url);
  const formats = formatsFromUrls(directUrls);

  return {
    url,
    title: embed.title || htmlEntities(ogTitle || metaTitle || 'Haat Link Media'),
    author: embed.author_name || 'Unknown creator',
    authorUrl: embed.author_url,
    platform,
    category: formats.some((f: any) => f.type === 'audio') && !formats.some((f: any) => f.type === 'video') ? 'audio' : 'video',
    thumbnailUrl: embed.thumbnail_url || thumbnail,
    description: htmlEntities(metaDescription || ''),
    duration: '00:00',
    durationSeconds: 0,
    formats,
    subtitles: [],
    resolver: 'cloudflare-free-edge',
    directFormatsAvailable: formats.length > 0,
    processingNote: formats.length > 0
      ? undefined
      : 'This Free Worker cannot run yt-dlp/ffmpeg. A MEDIA_RESOLVER_URL can be configured for full platform extraction and format selection.',
  };
}

async function resolveViaExternal(url: string, request: Request, env: Env, rawHtml?: string): Promise<any | null> {
  const base = (env.MEDIA_RESOLVER_URL || '').trim();
  if (!base) return null;
  try {
    const target = new URL(base);
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
    if (env.MEDIA_RESOLVER_TOKEN) headers.set('Authorization', `Bearer ${env.MEDIA_RESOLVER_TOKEN}`);
    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, rawHtml, client: 'haat-link-free-worker' }),
    });
    if (!response.ok) throw new Error(`Media resolver returned ${response.status}`);
    return await response.json();
  } catch (error: any) {
    console.warn('[HAAT] External media resolver failed:', error?.message || error);
    return null;
  }
}

async function gemini(env: Env, prompt: string): Promise<string | null> {
  const key = (env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  const models = [env.GEMINI_PRIMARY_MODEL || 'gemini-2.5-flash', ...(env.GEMINI_FALLBACK_MODELS || '').split(',').map((v) => v.trim()).filter(Boolean)];
  for (const model of [...new Set(models)]) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
      });
      if (!response.ok) continue;
      const data: any = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
      if (text) return text;
    } catch {}
  }
  return null;
}

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  const limited = rateLimit(request, env, 'ai', Number(env.AI_RATE_LIMIT || 10));
  if (limited) return limited;
  const body = await readBody(request, 900_000);
  const title = String(body.title || 'Media');
  const author = String(body.author || 'Unknown');
  const platform = String(body.platform || 'generic');
  const language = body.language === 'en' ? 'English' : body.language === 'ar' ? 'Arabic' : 'Egyptian Arabic';
  const transcript = typeof body.transcript === 'string' ? body.transcript.slice(0, 8000) : '';
  const prompt = `You are Haat AI. Analyze media metadata honestly. Language: ${language}. Title: ${title}. Author: ${author}. Platform: ${platform}. Description: ${String(body.description || '').slice(0, 1500)}. Transcript if available: ${transcript || 'none'}. Never invent spoken content when transcript is absent. Return JSON with summary, keyPoints, keyTakeaways, chapters, topics, suggestedTags, sentiment.`;
  const generated = await gemini(env, prompt);
  if (!generated) {
    const points = ['محتوى رقمي منشور على المنصة.', 'التحليل مبني على البيانات المتاحة فقط.'];
    return json({ analysisType: transcript ? 'transcript_based' : 'metadata_based', disclaimer: 'Haat AI يعمل داخل Cloudflare Worker المجاني.', summary: `"${title}" - ${author} (${platform}).`, keyPoints: points, keyTakeaways: points, chapters: [{ timestamp: '00:00', title }], topics: [platform, 'Media'], suggestedTags: [platform], sentiment: 'Informative' }, request, env);
  }
  try {
    const parsed = JSON.parse(generated.replace(/^```json\s*/i, '').replace(/\s*```$/i, ''));
    return json({ analysisType: transcript ? 'transcript_based' : 'metadata_based', disclaimer: 'Haat AI analysis.', ...parsed, keyTakeaways: parsed.keyTakeaways || parsed.keyPoints || [] }, request, env);
  } catch {
    return json({ analysisType: transcript ? 'transcript_based' : 'metadata_based', disclaimer: 'Haat AI analysis.', summary: generated.slice(0, 2000), keyPoints: [], keyTakeaways: [], chapters: [], topics: [platform], suggestedTags: [platform], sentiment: 'Informative' }, request, env);
  }
}

async function handleAsk(request: Request, env: Env): Promise<Response> {
  const limited = rateLimit(request, env, 'ai', Number(env.AI_RATE_LIMIT || 10));
  if (limited) return limited;
  const body = await readBody(request, 700_000);
  const question = String(body.question || '').slice(0, 4000);
  const prompt = `You are Haat AI. Answer the user's question using only the supplied media metadata and transcript. Do not claim to have watched/heard the media if no transcript is supplied. Language: ${body.language === 'en' ? 'English' : 'Egyptian Arabic'}. Question: ${question}. Title: ${String(body.title || '')}. Author: ${String(body.author || '')}. Platform: ${String(body.platform || '')}. Transcript: ${String(body.transcript || '').slice(0, 8000) || 'none'}. Return JSON: {"answer":"...","basedOn":"transcript|metadata"}.`;
  const generated = await gemini(env, prompt);
  if (!generated) return json({ answer: 'خدمة Haat AI غير مهيأة حالياً.', basedOn: 'metadata' }, request, env);
  try { return json(JSON.parse(generated.replace(/^```json\s*/i, '').replace(/\s*```$/i, '')), request, env); } catch { return json({ answer: generated.slice(0, 4000), basedOn: body.transcript ? 'transcript' : 'metadata' }, request, env); }
}

async function proxyMedia(request: Request, env: Env): Promise<Response> {
  const target = safeTarget(new URL(request.url).searchParams.get('url') || '');
  if (!target) return json({ error: 'Valid public media URL is required' }, request, env, 400);
  const headers = new Headers();
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  headers.set('User-Agent', 'Mozilla/5.0 (compatible; HaatLink/FreeWorker)');
  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' });
    const responseHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set('Accept-Ranges', 'bytes');
    return withCors(new Response(upstream.body, { status: upstream.status, headers: responseHeaders }), request, env);
  } catch (error: any) {
    return json({ error: error?.message || 'Media proxy failed' }, request, env, 502);
  }
}

async function fetchHtmlExtractor(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request, Number(env.MAX_HTML_BYTES || 2_000_000));
  let rawHtml = typeof body.rawHtml === 'string' ? body.rawHtml : '';
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawHtml && url) {
    const target = safeTarget(url);
    if (!target) return json({ error: 'Unsafe or invalid URL' }, request, env, 400);
    const response = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HaatLink/FreeWorker)' } });
    if (!response.ok) return json({ error: `Unable to fetch page (${response.status})` }, request, env, 502);
    rawHtml = await response.text();
  }
  if (!rawHtml.trim()) return json({ error: 'Source code or target URL is required' }, request, env, 400);
  const mediaUrls = extractDirectMedia(rawHtml, url || 'https://example.com/');
  const title = htmlEntities(rawHtml.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'Extracted Media').replace(/\s+/g, ' ').trim();
  if (!mediaUrls.length) return json({ error: 'لم يتم العثور على أي وسائط مباشرة داخل المصدر.', items: [] }, request, env, 404);
  const items = mediaUrls.map((mediaUrl, index) => ({ id: `extracted-${index + 1}`, index: index + 1, title: `${title.slice(0, 60)} #${index + 1}`, author: new URL(mediaUrl).hostname, duration: '--:--', durationSeconds: 0, thumbnailUrl: '', url: mediaUrl, selected: true, format: /\.(mp3|m4a|wav|ogg|opus)(?:\?|$)/i.test(mediaUrl) ? 'mp3' : 'mp4', type: /\.(mp3|m4a|wav|ogg|opus)(?:\?|$)/i.test(mediaUrl) ? 'audio' : 'video' }));
  return json({ title, totalItems: items.length, items }, request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }), request, env);
      }
      if (url.pathname === '/' || url.pathname === '') return json({ service: 'Haat Link API', status: 'online', version: VERSION, runtime: 'Cloudflare Workers Free', endpoints: { session: '/api/session', health: '/api/health', resolve: 'POST /api/media/resolve', extractHtml: 'POST /api/media/extract-html', preview: 'GET /api/media/proxy?url=...', analyze: 'POST /api/ai/analyze', ask: 'POST /api/ai/ask' }, timestamp: new Date().toISOString() }, request, env);
      if (url.pathname === '/api/cors-debug') return json({ ok: true, worker: 'backend-haatlink', version: VERSION, origin: request.headers.get('Origin'), originAllowed: Boolean(allowedOrigin(request, env)), sessionSecretConfigured: Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) }, request, env);
      if (url.pathname === '/api/session' && request.method === 'GET') return sessionResponse(request, env);
      if (url.pathname === '/api/health') return json({ status: 'ok', service: 'Haat Link Edge', version: VERSION, runtime: 'workers-free', mediaEngine: env.MEDIA_RESOLVER_URL ? 'external' : 'edge-direct-only', ytDlp: false, ffmpeg: false }, request, env);
      if (url.pathname === '/health') return json({ status: 'ok', version: VERSION }, request, env);
      if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, request, env, 404);

      if (url.pathname === '/api/media/proxy') {
        if (!(await validSession(request, env))) return json({ error: 'Secure session required' }, request, env, 401);
        return proxyMedia(request, env);
      }

      if (!(await validSession(request, env))) return json({ error: 'Secure session required' }, request, env, 401);

      if (url.pathname === '/api/media/resolve' || url.pathname === '/api/media/parse') {
        const limited = rateLimit(request, env, 'api', Number(env.API_RATE_LIMIT || 30));
        if (limited) return limited;
        const body = await readBody(request, Number(env.MAX_HTML_BYTES || 2_000_000));
        const sourceUrl = typeof body.url === 'string' ? body.url.trim() : '';
        if (!sourceUrl) return json({ error: 'Valid URL string is required' }, request, env, 400);
        const target = safeTarget(sourceUrl);
        if (!target) return json({ error: 'Unsafe or invalid URL' }, request, env, 400);
        const external = await resolveViaExternal(sourceUrl, request, env, body.rawHtml);
        if (external) return json(external, request, env);
        try { return json(await edgeResolve(sourceUrl, typeof body.rawHtml === 'string' ? body.rawHtml : undefined), request, env); }
        catch (error: any) { return json({ success: false, code: 'PARSE_FAILED', error: error?.message || 'تعذر استخراج بيانات الوسائط.', originalUrl: sourceUrl, suggestFallback: true }, request, env, 200); }
      }

      if (url.pathname === '/api/media/extract-html' && request.method === 'POST') return fetchHtmlExtractor(request, env);
      if (url.pathname === '/api/media/preview' && request.method === 'POST') {
        const body = await readBody(request, 500_000);
        if (!body.url) return json({ error: 'URL is required' }, request, env, 400);
        return json({ success: false, code: 'EDGE_DIRECT_ONLY', error: 'Preview requires a direct media URL on the Free Worker.', proxyUrl: `${url.origin}/api/media/proxy?url=${encodeURIComponent(body.url)}` }, request, env, 200);
      }

      if (url.pathname === '/api/media/job/start' || url.pathname === '/api/media/download') {
        return json({ success: false, code: 'MEDIA_ENGINE_REQUIRED', error: 'Server-side yt-dlp/ffmpeg downloads require an external media engine. Configure MEDIA_RESOLVER_URL to enable full format/download processing.' }, request, env, 501);
      }
      if (/^\/api\/media\/job\/[^/]+\//.test(url.pathname)) return json({ success: false, code: 'MEDIA_ENGINE_REQUIRED', error: 'Background download jobs are disabled on the Free Worker until an external media engine is configured.' }, request, env, 501);
      if (url.pathname === '/api/ai/analyze') return handleAnalyze(request, env);
      if (url.pathname === '/api/ai/ask') return handleAsk(request, env);
      return json({ error: 'Not found' }, request, env, 404);
    } catch (error: any) {
      console.error('[HAAT] Worker error:', error?.stack || error);
      const response = new Response(JSON.stringify({
        error: error?.message || 'Internal Worker error',
        code: 'WORKER_INTERNAL_ERROR',
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
      return withCors(response, request, env);
    }
  },
} satisfies ExportedHandler<Env>;
