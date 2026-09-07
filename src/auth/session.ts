// HaatLink session implementation — verified export for production Docker build
import * as nodeCrypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config/env';

const SESSION_SECRET = (config.sessionSecret || '').trim();
if (config.nodeEnv === 'production' && SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be configured with at least 32 characters in production');
}
const EFFECTIVE_SESSION_SECRET = SESSION_SECRET || Buffer.from(nodeCrypto.randomBytes(32)).toString('hex');

export function signSession(id: string): string {
  return nodeCrypto.createHmac('sha256', EFFECTIVE_SESSION_SECRET).update(id).digest('base64url');
}

export function issueSession(res: Response): string {
  const id = Buffer.from(nodeCrypto.randomBytes(32)).toString('base64url');
  const value = `${id}.${signSession(id)}`;
  const production = config.nodeEnv === 'production';
  const crossSite = Boolean(config.frontendOrigin && !config.frontendOrigin.includes('localhost'));
  const secure = production || crossSite ? '; Secure' : '';
  const sameSite = production || crossSite ? 'None' : 'Lax';
  res.setHeader('Set-Cookie', `haat_session=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=2592000${secure}`);
  return id;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie || '';
  const match = header.match(/(?:^|;\s*)haat_session=([^;]+)/);
  if (!match) return null;
  let decoded = '';
  try { decoded = decodeURIComponent(match[1]); } catch { return null; }
  const dot = decoded.indexOf('.');
  if (dot <= 0 || dot === decoded.length - 1) return null;
  const id = decoded.slice(0, dot);
  const signature = decoded.slice(dot + 1);
  const expected = signSession(id);
  if (signature.length !== expected.length) return null;
  try {
    return nodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? id : null;
  } catch { return null; }
}

export function getSessionId(req: Request): string {
  const id = readSessionCookie(req);
  if (!id) throw new Error('Secure session required');
  return id;
}
