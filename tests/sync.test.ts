import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { SyncStoreDb, type Sql } from '../worker/syncStore';
import { verifyAccessJwt, AccessError, parseEmailList } from '../worker/access';
import { Collection } from '../src/core/collection';
import { MemoryPersistence } from '../src/core/db';
import { NT_BASIC } from '../src/core/notetypes';
import { SyncClient } from '../src/sync/client';
import { importRows, type CardStoreRow } from '../src/importers/ankidb';
import { CardState } from '../src/core/types';

async function sqlStore(): Promise<SyncStoreDb> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const sql: Sql = {
    exec(q, ...params) {
      const stmt = db.prepare(q);
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
  return new SyncStoreDb(sql);
}

describe('Durable Object sync store', () => {
  it('last write wins by change time, and pulls skip the writer', async () => {
    const s = await sqlStore();
    let r = s.sync({ clientId: 'A', since: 0, changes: [{ store: 'cards', id: '1', changedAt: 100, data: { v: 'a' } }] });
    expect(r.accepted).toBe(1);
    expect(r.rows).toHaveLength(0); // own write is not echoed
    // Older change from B loses.
    r = s.sync({ clientId: 'B', since: 0, changes: [{ store: 'cards', id: '1', changedAt: 50, data: { v: 'b' } }] });
    expect(r.accepted).toBe(0);
    expect(r.rows).toEqual([{ store: 'cards', id: '1', changedAt: 100, data: { v: 'a' } }]);
    // Newer change from B wins; A then pulls it.
    r = s.sync({ clientId: 'B', since: r.cursor, changes: [{ store: 'cards', id: '1', changedAt: 200, data: { v: 'b2' } }] });
    expect(r.accepted).toBe(1);
    r = s.sync({ clientId: 'A', since: 1, changes: [] });
    expect(r.rows.map((x) => x.data)).toEqual([{ v: 'b2' }]);
  });

  it('stores tombstones and pages large pulls', async () => {
    const s = await sqlStore();
    const changes = Array.from({ length: 1000 }, (_, i) => ({ store: 'revlog' as const, id: String(i), changedAt: 1, data: { i } }));
    s.sync({ clientId: 'A', since: 0, changes });
    s.sync({ clientId: 'A', since: 0, changes: changes.map((c) => ({ ...c, id: String(1000 + Number(c.id)) })) });
    s.sync({ clientId: 'A', since: 0, changes: [{ store: 'revlog', id: '5', changedAt: 2, data: null }] });
    s.sync({ clientId: 'A', since: 0, changes: [{ store: 'revlog', id: 'extra', changedAt: 2, data: { x: 1 } }] });
    let r = s.sync({ clientId: 'B', since: 0, changes: [] });
    expect(r.rows).toHaveLength(2000);
    expect(r.more).toBe(true);
    const all = [...r.rows];
    r = s.sync({ clientId: 'B', since: r.cursor, changes: [] });
    expect(r.more).toBe(false);
    all.push(...r.rows);
    expect(all).toHaveLength(2001);
    expect(all).toContainEqual({ store: 'revlog', id: '5', changedAt: 2, data: null });
    expect(s.stats().revlog).toBe(2000);
  });

  it('rejects junk', async () => {
    const s = await sqlStore();
    expect(() => s.sync({} as never)).toThrow();
    const r = s.sync({ clientId: 'A', since: 0, changes: [{ store: 'nope' as never, id: '1', changedAt: 1, data: {} }] });
    expect(r.accepted).toBe(0);
  });
});

describe('two devices syncing through one store', () => {
  async function device(store: SyncStoreDb, clock: { now: number }) {
    const col = new Collection(new MemoryPersistence());
    col.clock = () => clock.now;
    await col.load();
    const client = new SyncClient(col, async (req) => structuredClone(store.sync(structuredClone(req))));
    return { col, client };
  }

  it('reviews made on one device appear on the other, newer edits win, and a wiped device recovers', async () => {
    const store = await sqlStore();
    const clock = { now: new Date(2026, 9, 29, 12).getTime() };
    const a = await device(store, clock);
    const deck = a.col.getOrCreateDeck('Spanish');
    const note = a.col.addNote(NT_BASIC, ['perro', 'dog'], [], deck.id);
    const cardId = a.col.cardsOfNote(note.id)[0].id;
    a.col.answer(cardId, 4, 2000);
    await a.client.sync();
    expect(a.client.status.state).toBe('idle');
    expect(a.col.syncJournal.size).toBe(0);

    clock.now += 1000;
    const b = await device(store, clock);
    await b.client.sync();
    const onB = b.col.cards.get(cardId)!;
    expect(onB.state).toBe(CardState.Review);
    expect(b.col.revlogFor(cardId)).toHaveLength(1);
    expect(b.col.deckByName('Spanish')).toBeDefined();
    // Fresh-device defaults never overwrite synced presets.
    expect(b.col.notes.get(note.id)!.fields[0]).toBe('perro');

    // Conflicting flag changes: B's later change wins on both.
    a.col.setFlag([cardId], 1);
    clock.now += 1000;
    b.col.setFlag([cardId], 3);
    await a.client.sync();
    await b.client.sync();
    await a.client.sync();
    expect(a.col.cards.get(cardId)!.flag).toBe(3);
    expect(b.col.cards.get(cardId)!.flag).toBe(3);

    // A preset change on B reaches A.
    b.col.saveConfig({ ...b.col.configFor(deck.id), newPerDay: 7 });
    await b.client.sync();
    await a.client.sync();
    expect(a.col.configFor(deck.id).newPerDay).toBe(7);

    // Clearing the browser: everything comes back from the server.
    await a.col.wipe();
    expect(a.col.cards.size).toBe(0);
    await a.client.sync();
    expect(a.col.cards.get(cardId)?.state).toBe(CardState.Review);
    expect(a.col.revlogFor(cardId)).toHaveLength(1);
    expect(a.col.configFor(deck.id).newPerDay).toBe(7);
    expect(a.col.cards.get(cardId)!.flag).toBe(3);
  });

  it('server content gets the same ids on every device and never clobbers synced scheduling', async () => {
    const store = await sqlStore();
    const clock = { now: new Date(2026, 9, 29, 12).getTime() };
    const rows: CardStoreRow[] = [
      { id: 1, created_at: '2026-10-29T16:00:00+00:00', guid: 'g1', deck: 'Top::Sub', card_type: 'basic', front: 'Q1', back: 'A1', extra: null, tags: 't', lesson: null, url: null },
      { id: 2, created_at: '2026-10-29T16:00:00+00:00', guid: 'g2', deck: 'Top::Sub', card_type: 'cloze', front: '{{c1::x}} {{c2::y}}', back: '', extra: null, tags: '', lesson: null, url: null },
    ];
    const a = await device(store, clock);
    importRows(a.col, rows, { deterministic: true });
    const ids = [...a.col.cards.keys()].sort();
    expect(ids).toHaveLength(3);
    const first = a.col.cardsOfNote(a.col.noteByGuid('cs-g1')!.id)[0];
    a.col.answer(first.id, 3, 1000);
    await a.client.sync();

    clock.now += 60_000;
    const b = await device(store, clock);
    // B loads content *before* pulling: its new-card copies must lose to A's reviewed card.
    importRows(b.col, rows, { deterministic: true });
    expect([...b.col.cards.keys()].sort()).toEqual(ids);
    expect(b.col.deckByName('Top::Sub')!.id).toBe(a.col.deckByName('Top::Sub')!.id);
    await b.client.sync();
    expect(b.col.cards.get(first.id)!.state).toBe(CardState.Learning);
    await a.client.sync();
    expect(a.col.cards.get(first.id)!.state).toBe(CardState.Learning);
  });
});

describe('Access JWT verification', () => {
  const team = 'example.cloudflareaccess.com';
  const aud = 'aud-tag-123';

  async function signer() {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const kid = crypto.randomUUID();
    const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid };
    const b64 = (b: Uint8Array | string) =>
      Buffer.from(typeof b === 'string' ? b : b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const sign = async (claims: Record<string, unknown>) => {
      const h = b64(JSON.stringify({ alg: 'RS256', kid }));
      const p = b64(JSON.stringify(claims));
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(`${h}.${p}`)));
      return `${h}.${p}.${b64(sig)}`;
    };
    return { sign, fetcher: async () => ({ keys: [jwk as JsonWebKey & { kid: string }] }) };
  }

  const cfg = { teamDomain: team, aud, allowedEmails: ['mark@marklynch.dev'] };
  const good = (now: number) => ({ aud: [aud], iss: `https://${team}`, exp: now / 1000 + 600, email: 'Mark@MarkLynch.dev' });

  it('accepts a valid token and returns the email', async () => {
    const { sign, fetcher } = await signer();
    const now = Date.now();
    await expect(verifyAccessJwt(await sign(good(now)), cfg, { fetcher, now })).resolves.toEqual({ email: 'mark@marklynch.dev' });
  });

  it('rejects wrong audience, issuer, expiry, email, signature', async () => {
    const { sign, fetcher } = await signer();
    const other = await signer();
    const now = Date.now();
    const bad = [
      await sign({ ...good(now), aud: ['other'] }),
      await sign({ ...good(now), iss: 'https://evil.cloudflareaccess.com' }),
      await sign({ ...good(now), exp: now / 1000 - 3600 }),
      await sign({ ...good(now), email: 'someone@else.com' }),
      await other.sign(good(now)),
      'not.a.jwt',
    ];
    for (const t of bad) await expect(verifyAccessJwt(t, cfg, { fetcher, now })).rejects.toBeInstanceOf(AccessError);
  });

  it('allows every address in a comma-separated ALLOWED_EMAILS list', async () => {
    const { sign, fetcher } = await signer();
    const now = Date.now();
    const allowed = parseEmailList(' mark@marklynch.dev , Friend@Other.org ,');
    expect(allowed).toEqual(['mark@marklynch.dev', 'friend@other.org']);
    expect(parseEmailList('mark@marklynch.dev,phil@upvalue.io')).toEqual(['mark@marklynch.dev', 'phil@upvalue.io']);
    const multi = { ...cfg, allowedEmails: allowed };
    await expect(verifyAccessJwt(await sign({ ...good(now), email: 'friend@other.org' }), multi, { fetcher, now })).resolves.toEqual({
      email: 'friend@other.org',
    });
    await expect(verifyAccessJwt(await sign({ ...good(now), email: 'third@x.com' }), multi, { fetcher, now })).rejects.toBeInstanceOf(AccessError);
  });
});
