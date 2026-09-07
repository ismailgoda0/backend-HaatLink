import dns from 'dns/promises';
import net from 'net';
import { URL } from 'url';

const BLOCKED_HOSTS = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'instance-data',
  'instance-data.ec2.internal', 'kubernetes.default.svc', 'kubernetes.default',
]);

export function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) || (a === 192 && b === 0 && c === 2);
  }
  if (version === 6) {
    const n = ip.toLowerCase();
    if (n.startsWith('::ffff:')) {
      const v4 = n.slice(7);
      return net.isIP(v4) === 4 ? isPrivateOrReservedIp(v4) : true;
    }
    return n === '::1' || n === '::' || n.startsWith('fc') || n.startsWith('fd') ||
      n.startsWith('fe8') || n.startsWith('fe9') || n.startsWith('fea') || n.startsWith('feb') || n.startsWith('ff');
  }
  return true;
}

export function isSafeUrl(rawUrl: string): { safe: boolean; error?: string; parsedUrl?: URL } {
  if (!rawUrl || typeof rawUrl !== 'string') return { safe: false, error: 'URL must be a non-empty string' };
  if (rawUrl.length > 2048) return { safe: false, error: 'URL exceeds maximum allowable length' };
  let parsed: URL;
  try { parsed = new URL(rawUrl.trim()); } catch { return { safe: false, error: 'Invalid URL format' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { safe: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  if (parsed.username || parsed.password) return { safe: false, error: 'Credential-bearing URLs are not allowed' };
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      hostname.endsWith('.corp') || hostname.endsWith('.home.arpa') || hostname.endsWith('.localhost')) {
    return { safe: false, error: 'Access to internal or private hosts is prohibited' };
  }
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) return { safe: false, error: 'Access to private or reserved IP ranges is blocked' };
  return { safe: true, parsedUrl: parsed };
}

export async function validateUrlForServerAccess(rawUrl: string): Promise<{ safe: boolean; error?: string; parsedUrl?: URL; addresses?: string[] }> {
  const basic = isSafeUrl(rawUrl);
  if (!basic.safe || !basic.parsedUrl) return basic;
  const hostname = basic.parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) return basic;
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    const addresses = records.map((r) => r.address);
    if (!addresses.length || addresses.some(isPrivateOrReservedIp)) return { safe: false, error: 'DNS resolved to a private or reserved network address' };
    return { ...basic, addresses };
  } catch { return { safe: false, error: 'Unable to safely resolve the target host' }; }
}

/** Validate every URL in a redirect chain before following it. */
export async function safeFetch(input: string, init: RequestInit = {}, maxRedirects = 3): Promise<Response> {
  let current = input;
  for (let i = 0; i <= maxRedirects; i++) {
    const check = await validateUrlForServerAccess(current);
    if (!check.safe) throw new Error(check.error || 'Unsafe URL');

    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (i === maxRedirects) throw new Error('Too many redirects');

    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect without destination');
    const next = new URL(location, current);
    if (!['http:', 'https:'].includes(next.protocol)) throw new Error('Unsafe redirect protocol');
    current = next.toString();
  }
  throw new Error('Too many redirects');
}

export function sanitizeFilename(input: string, fallback = 'haatlink_media'): string {
  if (!input || typeof input !== 'string') return fallback;
  let clean = input.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, ' ').replace(/\.{2,}/g, ' ').replace(/[. ]+$/g, '').trim().slice(0, 100).trim();
  const reserved = /^(CON|PRN|AUX|NUL|COM[0-9]+|LPT[0-9]+)$/i;
  if (!clean || reserved.test(clean)) clean = fallback;
  return clean;
}
