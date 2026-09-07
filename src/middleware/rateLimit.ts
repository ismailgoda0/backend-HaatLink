import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { readSessionCookie } from '../auth/session';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

function rateLimit(windowMs: number, max: number) {
  const safeMax = Math.max(1, Math.floor(max));
  return (req: Request, res: Response, next: NextFunction) => {
    const session = readSessionCookie(req) || 'anonymous';
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const endpoint = typeof req.route?.path === 'string' ? req.route.path : req.baseUrl || req.path;
    const key = `${session}:${clientIp}:${req.method}:${endpoint}`;
    const now = Date.now();
    let current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      current = { count: 0, resetAt: now + windowMs };
      buckets.set(key, current);
    }
    current.count += 1;
    res.setHeader('X-RateLimit-Limit', safeMax);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, safeMax - current.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(current.resetAt / 1000));
    if (current.count > safeMax) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let removed = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++removed >= excess) break;
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref?.();

export function createRateLimiters() {
  return {
    apiLimit: rateLimit(60_000, Number(config.apiRateLimit || 30)),
    heavyLimit: rateLimit(60_000, Number(config.heavyRateLimit || 8)),
    streamLimit: rateLimit(60_000, Number(config.streamRateLimit || 12)),
    aiLimit: rateLimit(60_000, Number(config.aiRateLimit || 10)),
    aiDailyLimit: rateLimit(24 * 60 * 60 * 1000, Number(config.aiDailyQuota || 100)),
  };
}
