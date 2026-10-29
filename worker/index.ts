import { DurableObject } from 'cloudflare:workers';
import { AccessError, parseEmailList, tokenFromRequest, verifyAccessJwt } from './access';
import { SyncStoreDb } from './syncStore';
import type { SyncRequest, SyncResponse } from '../src/sync/protocol';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  USER_STATE: DurableObjectNamespace<UserState>;
  /** Zero Trust team domain, e.g. "myteam.cloudflareaccess.com". */
  TEAM_DOMAIN?: string;
  /** AUD tag of the Access application protecting this Worker. */
  POLICY_AUD?: string;
  /** Comma separated emails allowed in addition to the Access policy. */
  ALLOWED_EMAILS?: string;
  /** Local development only (`.dev.vars`): identity used on localhost. */
  DEV_EMAIL?: string;
}

/** Per-user state: review log, scheduling state, decks, presets, settings. One instance per email. */
export class UserState extends DurableObject<Env> {
  private store: SyncStoreDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.store = new SyncStoreDb({
      exec: (q, ...p) => sql.exec(q, ...p).toArray() as Record<string, unknown>[],
    });
  }

  sync(req: SyncRequest): SyncResponse {
    return this.ctx.storage.transactionSync(() => this.store.sync(req));
  }

  stats(): Record<string, number> {
    return this.store.stats();
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });

async function authenticate(req: Request, env: Env): Promise<{ email: string } | { error: string }> {
  const url = new URL(req.url);
  if (env.DEV_EMAIL && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return { email: env.DEV_EMAIL.toLowerCase() };
  }
  // Fail closed until Access is configured.
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return { error: 'Cloudflare Access is not configured for this Worker' };
  const token = tokenFromRequest(req);
  if (!token) return { error: 'Missing Cloudflare Access token' };
  try {
    return await verifyAccessJwt(token, {
      teamDomain: env.TEAM_DOMAIN,
      aud: env.POLICY_AUD,
      allowedEmails: parseEmailList(env.ALLOWED_EMAILS),
    });
  } catch (e) {
    return { error: e instanceof AccessError ? `Access token rejected: ${e.message}` : 'Access token verification failed' };
  }
}

async function content(env: Env): Promise<Response> {
  const meta = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updated FROM cards').first<{ n: number; updated: string }>();
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.guid, d.name AS deck, c.card_type, c.front, c.back, c.extra, c.tags, c.position, c.created_at,
            s.title AS lesson, s.url
     FROM cards c JOIN decks d ON d.id = c.deck_id LEFT JOIN sources s ON s.id = c.source_id
     ORDER BY d.name, s.slug, c.position`,
  ).all();
  return json({ version: `${meta?.n ?? 0}:${meta?.updated ?? ''}`, rows: results });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const auth = await authenticate(req, env);
    if ('error' in auth) {
      if (url.pathname.startsWith('/api/')) return json({ error: auth.error }, 403);
      return new Response(`403 Forbidden\n\n${auth.error}. Sign in through Cloudflare Access.\n`, {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/me') return json({ email: auth.email });
    if (url.pathname === '/api/content' && req.method === 'GET') return content(env);
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      let body: SyncRequest;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }
      const stub = env.USER_STATE.get(env.USER_STATE.idFromName(auth.email));
      try {
        return json(await stub.sync(body));
      } catch (e) {
        return json({ error: String((e as Error).message ?? e) }, 400);
      }
    }
    if (url.pathname === '/api/stats') {
      const stub = env.USER_STATE.get(env.USER_STATE.idFromName(auth.email));
      return json(await stub.stats());
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    const res = await env.ASSETS.fetch(req);
    // Authenticated pages must not be cached by shared caches.
    const out = new Response(res.body, res);
    out.headers.set('cache-control', url.pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    return out;
  },
} satisfies ExportedHandler<Env>;
