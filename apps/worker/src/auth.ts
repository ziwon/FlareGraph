import type { Env } from './env.js';

/**
 * Auth boundary (planning §6.7 / §13):
 * 1. Cloudflare Access JWT (Cf-Access-Jwt-Assertion) — email login or Access
 *    service token, verified against the team's JWKS.
 * 2. Bearer API_TOKEN — fallback for setups without a custom domain in front.
 * If neither ACCESS_* nor API_TOKEN is configured, requests are rejected
 * (fail closed) except in `wrangler dev`.
 */

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3600_000) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export interface AuthResult {
  ok: boolean;
  subject?: string; // email or token client id
  method?: 'access-jwt' | 'bearer' | 'dev';
}

async function verifyAccessJwt(token: string, env: Env): Promise<AuthResult> {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return { ok: false };
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as {
    kid?: string;
    alg?: string;
  };
  if (header.alg !== 'RS256') return { ok: false };
  const keys = await getJwks(env.ACCESS_TEAM_DOMAIN!);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false };
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(sig) as unknown as ArrayBuffer,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false };
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
    aud?: string | string[];
    exp?: number;
    email?: string;
    common_name?: string;
  };
  if (!env.ACCESS_AUD) return { ok: false };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) return { ok: false };
  if (!payload.exp || payload.exp * 1000 < Date.now()) return { ok: false };
  return { ok: true, subject: payload.email ?? payload.common_name, method: 'access-jwt' };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const accessJwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (accessJwt && env.ACCESS_TEAM_DOMAIN) {
    try {
      const r = await verifyAccessJwt(accessJwt, env);
      if (r.ok) return r;
    } catch {
      // fall through to other methods
    }
  }
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ') && env.API_TOKEN) {
    if (timingSafeEqual(auth.slice(7).trim(), env.API_TOKEN)) {
      return { ok: true, subject: 'api-token', method: 'bearer' };
    }
  }
  // wrangler dev only: no auth configured at all
  if (!env.API_TOKEN && !env.ACCESS_TEAM_DOMAIN) {
    const host = new URL(req.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1')
      return { ok: true, subject: 'dev', method: 'dev' };
  }
  return { ok: false };
}
