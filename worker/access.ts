// Verifies Cloudflare Access JWTs (RS256) against the team's public keys.

export interface AccessConfig {
  teamDomain: string; // e.g. "myteam.cloudflareaccess.com"
  aud: string; // Access application AUD tag
  allowedEmails: string[]; // empty = any identity Access let through
}

export interface AccessIdentity {
  email: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return res.json();
};

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function keysFor(teamDomain: string, fetcher: JwksFetcher, refresh = false): Promise<Jwk[]> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(url);
  if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return cached.keys;
  const { keys } = await fetcher(url);
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

export class AccessError extends Error {}

export async function verifyAccessJwt(
  token: string,
  cfg: AccessConfig,
  opts: { fetcher?: JwksFetcher; now?: number } = {},
): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessError('malformed token');
  const [h, p, s] = parts;
  const decode = <T>(part: string): T => {
    try {
      return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as T;
    } catch {
      throw new AccessError('malformed token');
    }
  };
  const header = decode<{ alg: string; kid: string }>(h);
  if (header.alg !== 'RS256') throw new AccessError('unexpected alg');
  const fetcher = opts.fetcher ?? defaultFetcher;
  let jwk = (await keysFor(cfg.teamDomain, fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keysFor(cfg.teamDomain, fetcher, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessError('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(s);
  } catch {
    throw new AccessError('malformed token');
  }
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AccessError('bad signature');

  const claims = decode<{
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
    email?: string;
  }>(p);
  const now = (opts.now ?? Date.now()) / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) throw new AccessError('wrong audience');
  if (claims.iss !== `https://${cfg.teamDomain}`) throw new AccessError('wrong issuer');
  if (!claims.exp || claims.exp < now - 30) throw new AccessError('expired');
  if (claims.nbf && claims.nbf > now + 30) throw new AccessError('not yet valid');
  const email = claims.email?.toLowerCase();
  if (!email) throw new AccessError('no email in token');
  if (cfg.allowedEmails.length && !cfg.allowedEmails.includes(email)) throw new AccessError('email not allowed');
  return { email };
}

/** "a@x.com, B@y.org" -> ["a@x.com", "b@y.org"] */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const cookie = req.headers.get('Cookie') ?? '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1] : null;
}
