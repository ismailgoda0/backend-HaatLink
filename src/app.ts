import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { platformResolver } from './server/providers/PlatformResolver';
import { downloadEngine } from './server/media/downloadEngine';
import { analyzeWithHaatAi, askHaatAi } from './server/ai/haatAi';
import { serverMediaCache } from './server/storage/serverMediaCache';
import { sanitizeFilename, validateUrlForServerAccess, safeFetch } from './server/security/ssrfValidator';
import { spawnYtDlp, terminateProcessTree, isYtDlpAvailable, isFfmpegAvailable } from './server/utils/binaryHelper';
import { config } from './config/env';
import { issueSession, readSessionCookie, getSessionId } from './auth/session';
import { createRateLimiters } from './middleware/rateLimit';
import { readResponseTextLimited, validateDownloadInput } from './utils/requestValidation';
import { streamZip } from './utils/zip';


const app = express();
app.set('trust proxy', Number.isFinite(Number(config.trustProxyHops)) ? Number(config.trustProxyHops) : 1);
app.disable('x-powered-by');

// Frontend is hosted on Firebase while the API is routed through Cloudflare Workers/Containers.
const allowedOrigins = new Set((config.frontendOrigin || 'http://localhost:5173,https://haat-link.web.app,https://haat-link.firebaseapp.com')
  .split(',').map((v) => v.trim()).filter(Boolean));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Range, X-Haat-Client');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const MAX_BODY = config.maxRequestBody || '2mb';
const MAX_BATCH_ITEMS = config.maxBatchItems;
const MAX_BATCH_TOTAL = config.maxBatchTotalBytes;

app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob: data:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-src 'self' https:;"
  );
  next();
});

const { apiLimit, heavyLimit, streamLimit, aiLimit, aiDailyLimit } = createRateLimiters();


app.get('/api/session', (req, res) => {
  const existing = readSessionCookie(req);
  if (!existing) issueSession(res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true });
});

app.get('/api/health', (_req, res) => { res.json({ status:'ok', service:'Haat Link Engine', name:'هات لينك | Haat Link', version:'0.1', time:new Date().toISOString(), dependencies:{ ytDlp:isYtDlpAvailable(), ffmpeg:isFfmpegAvailable(), storage:fs.existsSync(config.serverCacheDir || path.join(process.cwd(),'data','server_cache')) } , queue:{ maxConcurrent:Number(config.maxConcurrentDownloads || 2) } }); });

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/session') return next();
  if (!readSessionCookie(req)) return res.status(401).json({ error: 'Secure session required' });
  next();
});

const parseMediaHandler = async (req: Request, res: Response) => {
  const start = Date.now(); const { url, rawHtml } = req.body || {};
  try {
    if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error:'Valid URL string is required' });
    if (rawHtml !== undefined && (typeof rawHtml !== 'string' || rawHtml.length > 1_500_000)) return res.status(400).json({ error:'Invalid or oversized page source' });
    const metadata = await platformResolver.resolve(url, rawHtml);
    console.log(`[PARSE_OK] ${metadata.platform} (${Date.now()-start}ms)`);
    res.json(metadata);
  } catch (error: any) {
    const msg = error?.message || '';
    console.error(`[PARSE_FAIL] ${msg.slice(0,200)} (${Date.now()-start}ms)`);
    if (/FACEBOOK_LOGIN_RESTRICTION/i.test(msg) || (/facebook\.com/i.test(url || '') && /Cannot parse data|login|Sign in/i.test(msg))) {
      return res.status(200).json({ success: false, code:'FACEBOOK_SOURCE_REQUIRED', error:'فيديوهات فيسبوك المحمية قد تحتاج وضع مصدر الصفحة.', suggestFacebookPrivate:true, originalUrl:url });
    }
    if (/MEDIA_NOT_FOUND|404|Not Found|does not exist/i.test(msg)) {
      return res.status(200).json({ success: false, code:'MEDIA_UNAVAILABLE', error:'المحتوى غير موجود أو تم حذفه من المنصة الأصلية.', originalUrl:url });
    }
    if (/UNSUPPORTED_PLATFORM/i.test(msg)) {
      return res.status(200).json({ success: false, code:'UNSUPPORTED_PLATFORM', error:'المنصة دي مش مدعومة حاليًا.', originalUrl:url });
    }
    if (/PRIVATE_MEDIA|private/i.test(msg)) {
      return res.status(200).json({ success: false, code:'PRIVATE_MEDIA', error:'المحتوى ده خاص أو مقفول من صاحبه.', originalUrl:url });
    }
    if (/LOGIN_REQUIRED|login|Sign in/i.test(msg)) {
      return res.status(200).json({ success: false, code:'LOGIN_REQUIRED', error:'المحتوى ده محتاج تسجيل دخول أو تحقق أمني.', originalUrl:url });
    }
    return res.status(200).json({ success: false, code:'PARSE_FAILED', error:msg.slice(0,240) || 'تعذر استخراج بيانات الوسائط.', suggestFallback: true, originalUrl:url });
  }
};
app.post('/api/media/parse', apiLimit, parseMediaHandler);
app.post('/api/media/resolve', apiLimit, parseMediaHandler);

// Returns a browser-playable progressive URL through our secure local stream proxy.
app.post('/api/media/preview', heavyLimit, async (req, res) => {
  try {
    if (typeof req.body?.url !== 'string') return res.status(400).json({ error:'URL is required' });
    const check = await validateUrlForServerAccess(req.body.url.trim());
    if (!check.safe) return res.status(400).json({ error:check.error || 'Unsafe URL' });
    const previewHeight = Math.max(144, Math.min(1080, Number(config.previewMaxHeight || 720)));
    const args = [
      '--ignore-config','--no-warnings','--no-playlist','--socket-timeout','20','--get-url',
      '-f',`best[ext=mp4][vcodec!=none][acodec!=none][height<=${previewHeight}]/best[vcodec!=none][acodec!=none][height<=${previewHeight}]/best[ext=mp4][height<=${previewHeight}]/best[height<=${previewHeight}]`,
      req.body.url.trim()
    ];
    const directUrl = await new Promise<string>((resolve, reject) => {
      const child = spawnYtDlp(args,{stdio:['ignore','pipe','pipe']}); let out=''; let err='';
      const timer=setTimeout(()=>{ terminateProcessTree(child); reject(new Error('Preview resolution timed out')); },25_000);
      child.stdout.on('data',d=>{ out += d.toString(); if (out.length > 256_000) { terminateProcessTree(child); } }); child.stderr.on('data',d=>err+=d.toString());
      child.once('error',e=>{clearTimeout(timer);reject(e)}); child.once('close',code=>{clearTimeout(timer); if(code!==0) reject(new Error(err.trim().slice(-500)||'Unable to resolve preview stream')); else { const u=out.trim().split(/\r?\n/).find(Boolean); u ? resolve(u) : reject(new Error('No playable preview stream found')); }});
    });
    const directCheck = await validateUrlForServerAccess(directUrl);
    if (!directCheck.safe) return res.status(422).json({ error:'The provider returned an unsafe preview target.' });
    // Proxy through server to defeat IP-binding (like Google Video 403) and CORS blocks
    const proxiedStreamUrl = `/api/media/stream?url=${encodeURIComponent(directUrl)}`;
    res.json({ url: proxiedStreamUrl, directUrl, expiresHint:'short-lived provider URL' });
  } catch (e:any) { res.status(422).json({ error:e.message || 'Preview unavailable' }); }
});

// Secure stream proxy with Range request support for progressive video playback
app.get('/api/media/stream', streamLimit, async (req, res) => {
  try {
    const targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!targetUrl) return res.status(400).json({ error: 'URL is required' });
    const safety = await validateUrlForServerAccess(targetUrl);
    if (!safety.safe) return res.status(403).json({ error: safety.error || 'Prohibited URL' });

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: '*/*',
    };
    if (req.headers.range) {
      headers.range = req.headers.range;
    }

    const upstream = await safeFetch(targetUrl, { headers }, 3);
    const maxStreamBytes = Number(config.maxStreamBytes || 500 * 1024 * 1024);
    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (maxStreamBytes > 0 && contentLength > maxStreamBytes) return res.status(413).json({ error: 'Preview stream exceeds the configured limit.' });
    res.status(upstream.status);
    for (const [key, val] of upstream.headers) {
      if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    }
    res.setHeader('Accept-Ranges', 'bytes');
    if (!upstream.body) return res.end();

    const reader = upstream.body.getReader();
    let streamedBytes = 0;
    let aborted = false;
    req.on('close', () => { aborted = true; reader.cancel().catch(() => {}); });
    while (true) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      streamedBytes += value.byteLength;
      if (maxStreamBytes > 0 && streamedBytes > maxStreamBytes) {
        await reader.cancel().catch(() => {});
        if (!res.headersSent) res.status(413).json({ error: 'Preview stream exceeded the configured byte limit.' });
        else res.destroy();
        return;
      }
      if (!res.write(value)) await new Promise((r) => res.once('drain', r));
    }
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (err: any) {
    if (!res.headersSent) res.status(502).json({ error: err.message || 'Streaming proxy failed' });
  }
});

// Universal HTML Media Extractor for any website or pasted source code
app.post('/api/media/extract-html', heavyLimit, async (req, res) => {
  try {
    let { rawHtml, url } = req.body || {};
    if (!rawHtml && url && typeof url === 'string') {
      const safety = await validateUrlForServerAccess(url.trim());
      if (!safety.safe) return res.status(400).json({ error: safety.error || 'Prohibited URL' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      let resp: globalThis.Response;
      try {
        resp = await safeFetch(url.trim(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' },
          signal: controller.signal,
        }, 3);
      } finally {
        clearTimeout(timer);
      }
      const declaredLength = Number(resp.headers.get('content-length') || 0);
      const maxHtmlBytes = Number(config.maxHtmlBytes || 2 * 1024 * 1024);
      if (declaredLength > maxHtmlBytes) return res.status(413).json({ error: 'Target HTML is too large.' });
      const reader = resp.body?.getReader();
      if (!reader) return res.status(502).json({ error: 'Target page returned no body.' });
      const chunks: Uint8Array[] = []; let totalBytes = 0;
      while (true) { const {done,value}=await reader.read(); if(done) break; totalBytes += value.byteLength; if(totalBytes > maxHtmlBytes){ await reader.cancel(); return res.status(413).json({error:'Target HTML is too large.'}); } chunks.push(value); }
      rawHtml = Buffer.concat(chunks.map((c)=>Buffer.from(c))).toString('utf8');
    }

    if (typeof rawHtml !== 'string' || !rawHtml.trim()) {
      return res.status(400).json({ error: 'Source code or target URL is required' });
    }

    const html = rawHtml;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i) || html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    const pageTitle = (titleMatch ? titleMatch[1].replace(/[\r\n\t]+/g, ' ').trim() : 'Extracted Media') || 'Extracted Media';

    const foundUrls = new Set<string>();

    // 1. Meta tags
    const metaRegex = /<meta\s+(?:property|name)=["'](?:og:video|og:video:url|og:video:secure_url|twitter:player:stream)["']\s+content=["']([^"']+)["']/gi;
    let m;
    while ((m = metaRegex.exec(html)) !== null) {
      if (m[1]) foundUrls.add(m[1].replace(/&amp;/g, '&').replace(/\\/g, ''));
    }

    // 2. Video & Audio tags
    const videoSrcRegex = /<(?:video|source|audio)[^>]+src=["']([^"']+)["']/gi;
    while ((m = videoSrcRegex.exec(html)) !== null) {
      if (m[1]) foundUrls.add(m[1].replace(/&amp;/g, '&').replace(/\\/g, ''));
    }

    // 3. Native stream variables (Facebook, Instagram, etc.)
    const fbRegex = /(?:browser_native_hd_url|browser_native_sd_url|playable_url_quality_hd|playable_url|hd_src|sd_src):["']([^"']+)["']/gi;
    while ((m = fbRegex.exec(html)) !== null) {
      if (m[1]) foundUrls.add(m[1].replace(/\\/g, '').replace(/&amp;/g, '&'));
    }

    // 4. JSON / JS direct stream links
    const directRegex = /https?:\/\/[^\s"'\<\>]+?\.(?:mp4|webm|m3u8|mp3|m4a|wav)(?:\?[^\s"'\<\>]*)?/gi;
    while ((m = directRegex.exec(html)) !== null) {
      const u = m[0].replace(/\\/g, '').replace(/&amp;/g, '&');
      foundUrls.add(u);
    }

    const items = [];
    let idx = 1;
    for (const rawMediaUrl of foundUrls) {
      try {
        const parsed = new URL(rawMediaUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;
        const safety = await validateUrlForServerAccess(parsed.toString());
        if (!safety.safe) continue;
        const pathname = parsed.pathname.toLowerCase();
        const ext = pathname.endsWith('.mp3') || pathname.endsWith('.m4a') || pathname.endsWith('.wav') ? 'mp3' : 'mp4';
        const isAudio = ext === 'mp3';
        const rawFilename = decodeURIComponent(parsed.pathname.split('/').pop() || `Track_${idx}`).split('?')[0];

        items.push({
          id: `extracted-${idx}`,
          index: idx,
          title: `${pageTitle.slice(0, 35)} #${idx} (${rawFilename.slice(0, 30)})`,
          author: parsed.hostname,
          duration: '--:--',
          durationSeconds: 0,
          thumbnailUrl: 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=800&auto=format&fit=crop&q=80',
          url: rawMediaUrl,
          filesizeEst: undefined,
          selected: true,
          format: ext,
          type: isAudio ? 'audio' : 'video',
        });
        idx++;
        if (items.length >= 50) break;
      } catch {}
    }

    if (items.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على أي وسائط أو فيديوهات صالحة داخل كود الـ HTML المدخل.' });
    }

    res.json({
      title: pageTitle,
      totalItems: items.length,
      items,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to extract media from HTML' });
  }
});

app.post('/api/media/job/start', heavyLimit, async (req,res) => {
  try {
    const input=validateDownloadInput(req.body);
    const safety=await validateUrlForServerAccess(input.url);
    if(!safety.safe) return res.status(400).json({ error:safety.error || 'Unsafe URL' });
    const job=downloadEngine.createJob({ ...input, ownerId: getSessionId(req) });
    res.status(202).json({ jobId:job.id,fileName:job.fileName,status:job.status,range:job.range });
  } catch(e:any) { res.status(400).json({error:e.message || 'Failed to initialize download job'}); }
});

app.get('/api/media/job/:id/progress', apiLimit, (req,res) => {
  const job=downloadEngine.getJob(req.params.id); if(!job || job.ownerId !== getSessionId(req)) return res.status(404).json({error:'Job not found'});
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache, no-transform'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders?.();
  const send=(j:any)=>res.write(`data: ${JSON.stringify({id:j.id,status:j.status,progress:j.progress,downloadedBytes:j.downloadedBytes,totalBytes:j.totalBytes,speed:j.speed,eta:j.eta,fileName:j.fileName,error:j.error})}\n\n`);
  send(job); if(['completed','failed','cancelled'].includes(job.status)) return res.end();
  const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15_000); heartbeat.unref();
  const unsubscribe=downloadEngine.subscribe(req.params.id,(updated)=>{ send(updated); if(['completed','failed','cancelled'].includes(updated.status)){ clearInterval(heartbeat); unsubscribe(); res.end(); }});
  req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
});

app.get('/api/media/job/:id/file', apiLimit, (req,res)=>{
  const job=downloadEngine.getJob(req.params.id); if(!job || job.ownerId !== getSessionId(req)) return res.status(404).json({error:'Job not found'});
  if(job.status!=='completed'||!job.filePath||!fs.existsSync(job.filePath)) return res.status(400).json({error:'File is not ready or has expired'});
  res.download(job.filePath,job.fileName,(err)=>{ if(err) console.error('File transfer error',err); setTimeout(()=>{try{if(job.filePath&&fs.existsSync(job.filePath))fs.unlinkSync(job.filePath)}catch{}},60_000).unref(); });
});
app.post('/api/media/job/:id/cancel', apiLimit, (req,res)=>{ const job=downloadEngine.getJob(req.params.id); if(!job || job.ownerId !== getSessionId(req)) return res.status(404).json({error:'Job not found'}); res.json({success:downloadEngine.cancelJob(req.params.id)}); });

app.get('/api/media/download', heavyLimit, async (req,res)=>{
  try {
    const input=validateDownloadInput({url:req.query.url,title:req.query.title,format:req.query.ext,quality:req.query.quality,type:req.query.type,startSeconds:req.query.startSeconds,endSeconds:req.query.endSeconds,muteAudio:req.query.muteAudio==='true'||req.query.mute==='true',sourceFormatId:req.query.sourceFormatId});
    const safety=await validateUrlForServerAccess(input.url); if(!safety.safe) return res.status(400).json({error:safety.error});
    const job=downloadEngine.createJob({ ...input, ownerId: getSessionId(req) }); await waitForTerminal(job.id);
    if(job.status!=='completed'||!job.filePath||!fs.existsSync(job.filePath)) return res.status(500).json({error:job.error||'Download failed'});
    return res.download(job.filePath,job.fileName,()=>{try{if(job.filePath&&fs.existsSync(job.filePath))fs.unlinkSync(job.filePath)}catch{}});
  } catch(e:any){res.status(400).json({error:e.message||'Direct media download failed'});}
});

function waitForTerminal(id:string):Promise<void>{ return new Promise(resolve=>{ const j=downloadEngine.getJob(id); if(!j||['completed','failed','cancelled'].includes(j.status)) return resolve(); const u=downloadEngine.subscribe(id,x=>{if(['completed','failed','cancelled'].includes(x.status)){u();resolve();}}); }); }

app.post('/api/media/download-batch-zip', heavyLimit, async(req,res)=>{
  const tempPaths:string[]=[];
  try{
    const {playlistTitle='HaatLink_Playlist',items=[],format='mp3',quality='320k'}=req.body||{};
    if(!Array.isArray(items)||items.length===0) return res.status(400).json({error:'No items provided'});
    if(items.length>MAX_BATCH_ITEMS) return res.status(400).json({error:`Maximum ${MAX_BATCH_ITEMS} items per archive`});
    if(!['mp3','mp4','m4a','wav'].includes(format)) return res.status(400).json({error:'Unsupported batch format'});
    const prepared=[]; let total=0;
    for(const item of items){
      if(!item||typeof item.url!=='string') continue;
      const input=validateDownloadInput({url:item.url,title:item.title||'media',format,quality,type:format==='mp3'||format==='m4a'||format==='wav'?'audio':'video'});
      const safety=await validateUrlForServerAccess(input.url); if(!safety.safe) continue;
      const job=downloadEngine.createJob({ ...input, ownerId: getSessionId(req) }); await waitForTerminal(job.id);
      if(job.status==='completed'&&job.filePath&&fs.existsSync(job.filePath)){const size=fs.statSync(job.filePath).size; total+=size; if(total>MAX_BATCH_TOTAL) throw new Error('Batch archive exceeds the configured total size limit'); prepared.push({path:job.filePath,name:sanitizeFilename(item.title||'media')+'.'+format});tempPaths.push(job.filePath);} 
    }
    if(!prepared.length) return res.status(422).json({error:'No batch items could be downloaded'});
    const folderName=sanitizeFilename(String(playlistTitle),'HaatLink_Playlist'); res.setHeader('Content-Disposition',`attachment; filename="${folderName}.zip"`);res.setHeader('Content-Type','application/zip');await streamZip(prepared,res);
  }catch(e:any){if(!res.headersSent)res.status(500).json({error:e.message||'Failed to generate playlist zip archive'});}finally{for(const f of tempPaths)try{if(fs.existsSync(f))fs.unlinkSync(f)}catch{}}
});

// Server Media Cache (Local site storage for deep AI analysis and instant download)
app.get('/api/media/server-cache/list', apiLimit, (req, res) => {
  try {
    const sessionId = getSessionId(req);
    const items = serverMediaCache.getAll().filter((item) => item.ownerId === sessionId);
    res.json({ items });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to list server cached media' });
  }
});

app.get('/api/media/server-cache/status', apiLimit, (req, res) => {
  try {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const sessionId = getSessionId(req);
    const items = serverMediaCache.getByUrl(url, sessionId);
    res.json({ cached: items.length > 0, items });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to check server cache' });
  }
});

app.post('/api/media/server-cache/ingest', heavyLimit, async (req, res) => {
  try {
    const { url, title, platform, quality, format, duration, durationSeconds, thumbnailUrl } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Valid URL is required' });
    const item = await serverMediaCache.ingest({
      ownerId: getSessionId(req),
      url,
      title: typeof title === 'string' ? title : 'Media Video',
      platform: typeof platform === 'string' ? platform : 'web',
      quality,
      format,
      duration,
      durationSeconds,
      thumbnailUrl,
    });
    res.status(202).json({ success: true, item });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Failed to ingest media to server' });
  }
});

app.get('/api/media/server-cache/:id/download', apiLimit, (req, res) => {
  const item = serverMediaCache.getById(req.params.id, getSessionId(req));
  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).json({ error: 'Cached file not found on server' });
  }
  res.download(item.filePath, item.fileName);
});

app.delete('/api/media/server-cache/:id', apiLimit, (req, res) => {
  const success = serverMediaCache.delete(req.params.id, getSessionId(req));
  res.json({ success });
});

app.post('/api/ai/analyze', aiDailyLimit, aiLimit, async(req,res)=>{try{const {title,author,platform,url,cachedMediaId,duration,description,transcript,hasRealTranscript,language}=req.body||{}; if (typeof title === 'string' && title.length > 300) return res.status(400).json({error:'Title too long'}); if (typeof author === 'string' && author.length > 300) return res.status(400).json({error:'Author too long'}); if (typeof description === 'string' && description.length > 20000) return res.status(400).json({error:'Description too long'}); if (typeof transcript === 'string' && transcript.length > 20000) return res.status(400).json({error:'Transcript too long'}); const analysis=await analyzeWithHaatAi({ownerId:getSessionId(req),title:title||'Media',author:author||'Creator',platform:platform||'Web',url:typeof url==='string'?url:undefined,cachedMediaId:typeof cachedMediaId==='string'?cachedMediaId:undefined,duration,description:typeof description==='string'?description.slice(0,20_000):undefined,transcript:typeof transcript==='string'?transcript.slice(0,20_000):undefined,hasRealTranscript:Boolean(hasRealTranscript),language:language||'arz'});res.json(analysis);}catch(e:any){console.error(e);res.status(503).json({error:'AI analysis service temporarily unavailable'});}});
app.post('/api/media/transcript', apiLimit, async (req, res) => {
  try {
    const { url, subtitleUrl } = req.body || {};
    if (!url && !subtitleUrl) return res.status(400).json({ error: 'URL or subtitleUrl is required' });

    if (subtitleUrl && typeof subtitleUrl === 'string') {
      try {
        const subtitleCheck = await validateUrlForServerAccess(subtitleUrl);
        if (!subtitleCheck.safe) throw new Error(subtitleCheck.error || 'Unsafe subtitle URL');
        const resp = await safeFetch(subtitleUrl, {}, 3);
        if (resp.ok) {
          const raw = await readResponseTextLimited(resp, Number(config.maxTranscriptBytes || 2 * 1024 * 1024));
          const cleaned = raw
            .replace(/^WEBVTT.*$/gm, '')
            .replace(/^\d+$/gm, '')
            .replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{3}.*$/gm, '')
            .replace(/<[^>]+>/g, '')
            .replace(/\n{2,}/g, ' ')
            .trim();
          if (cleaned.length > 20) {
            return res.json({ transcript: cleaned.slice(0, 15000) });
          }
        }
      } catch {}
    }

    if (url && typeof url === 'string') {
      const safety = await validateUrlForServerAccess(url.trim());
      if (!safety.safe) return res.status(400).json({ error: safety.error || 'Unsafe URL' });
      const meta = await platformResolver.resolve(url);
      if (meta.subtitles && meta.subtitles.length > 0) {
        const best = meta.subtitles.find(s => s.langCode.startsWith('ar')) ||
                     meta.subtitles.find(s => s.langCode.startsWith('en')) ||
                     meta.subtitles[0];
        if (best && best.url) {
          try {
            const subtitleCheck = await validateUrlForServerAccess(best.url);
            if (!subtitleCheck.safe) throw new Error(subtitleCheck.error || 'Unsafe subtitle URL');
            const resp = await safeFetch(best.url, {}, 3);
            if (resp.ok) {
              const raw = await readResponseTextLimited(resp, Number(config.maxTranscriptBytes || 2 * 1024 * 1024));
              const cleaned = raw
                .replace(/^WEBVTT.*$/gm, '')
                .replace(/^\d+$/gm, '')
                .replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s*-->\s*\d{2}:\d{2}(?::\d{2})?[.,]\d{3}.*$/gm, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\n{2,}/g, ' ')
                .trim();
              if (cleaned.length > 20) {
                return res.json({ transcript: cleaned.slice(0, 15000) });
              }
            }
          } catch {}
        }
      }
    }

    res.json({ transcript: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to resolve transcript' });
  }
});

app.post('/api/ai/ask', aiDailyLimit, aiLimit, async(req,res)=>{try{const {question,title,author,platform,url,thumbnailUrl,cachedMediaId,transcript,hasRealTranscript,isBrowserCached,language}=req.body||{};if(typeof question!=='string'||!question.trim())return res.status(400).json({error:'Question is required'});if(question.length>3000)return res.status(400).json({error:'Question is too long'});const answer=await askHaatAi({question:question.trim(),ownerId:getSessionId(req),title:title||'Media',author:author||'Creator',platform:platform||'Web',url:typeof url==='string'?url:undefined,thumbnailUrl:typeof thumbnailUrl==='string'?thumbnailUrl:undefined,cachedMediaId:typeof cachedMediaId==='string'?cachedMediaId:undefined,transcript:typeof transcript==='string'?transcript.slice(0,20_000):undefined,hasRealTranscript:Boolean(hasRealTranscript),isBrowserCached:Boolean(isBrowserCached),language:language||'arz'});res.json(answer);}catch(e:any){console.error(e);res.status(503).json({error:'Failed to ask Haat AI'});}});

// Final error boundary: keep API failures JSON-shaped and preserve CORS
// headers that were already attached by the CORS middleware above.
app.use((error: unknown, _req: Request, res: Response, _next: (err?: unknown) => void) => {
  if (res.headersSent) return;
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error('[HAAT] Unhandled API error:', message);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
});

export { app };
export default app;
