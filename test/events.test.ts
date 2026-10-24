import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { mintToken, revokeToken } from '../src/shared/tokens.js';
import {
  oauthToken,
  PUBLIC_API_URL,
  startTestApp,
  staticToken,
  type TestApp,
  testAgent,
} from './helpers/app.js';
import { fakeSecrets, postEvent, RECEIVED_AT, validEvent } from './helpers/events.js';

const appDatabaseUrl = inject('appDatabaseUrl');

type LogLine = Record<string, unknown>;

const parseLines = (app: TestApp): LogLine[] =>
  app.logLines.map((line) => JSON.parse(line) as LogLine);

const requestLog = (app: TestApp, res: Response): LogLine | undefined =>
  parseLines(app).find(
    (l) => l.msg === 'request' && l.request_id === res.headers.get('x-request-id'),
  );

const eventsForKey = (app: TestApp, agentId: string, key: unknown) =>
  app.sql<{ event_id: string }[]>`
    SELECT event_id FROM events WHERE agent_id = ${agentId} AND client_event_id = ${String(key)}`;

/** Counts of the rows one event wrote, in each table. */
async function rowCounts(app: TestApp, eventId: string) {
  const [counts] = await app.sql<{ events: number; content: number; jobs: number; acts: number }[]>`
    SELECT (SELECT count(*)::int FROM events WHERE event_id = ${eventId}) AS events,
           (SELECT count(*)::int FROM event_content WHERE event_id = ${eventId}) AS content,
           (SELECT count(*)::int FROM jobs WHERE kind = 'extract' AND ref_id = ${eventId}) AS jobs,
           (SELECT count(*)::int FROM activity_log
             WHERE kind = 'event_append' AND target_id = ${eventId}) AS acts`;
  return counts;
}

/** POSTs `bytes` in 64 KiB chunks with no Content-Length, and reads whatever the server answers. */
function postChunked(
  app: TestApp,
  token: string,
  bytes: Buffer,
): Promise<{ status: number | undefined; chunked: boolean; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL('/v1/events', app.base),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, chunked, body }));
      },
    );
    // Without a Content-Length, node:http sends Transfer-Encoding: chunked.
    const chunked = !req.hasHeader('content-length');
    // The server may close the socket after answering; the response has already arrived by then.
    req.on('error', (err) => (req.writableEnded ? undefined : reject(err)));
    let offset = 0;
    const write = () => {
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        offset += chunk.length;
        if (!req.write(chunk)) {
          req.once('drain', write);
          return;
        }
      }
      req.end();
    };
    write();
  });
}

describe.skipIf(!appDatabaseUrl)('POST /v1/events', () => {
  let app: TestApp;
  const agent = testAgent('ev');
  const otherAgent = testAgent('ev2');
  let token: string;
  let tokenId: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl, { now: () => RECEIVED_AT });
    ({ token, tokenId } = await staticToken(app, agent));
    ({ token: otherToken } = await staticToken(app, otherAgent));
  });
  afterAll(() => app?.close());

  /** Posts and checks that a rejected request stored nothing under its key. */
  async function rejected(body: Record<string, unknown>, status: number, t: string = token) {
    const res = await postEvent(app, t, body);
    expect(res.status).toBe(status);
    expect(await eventsForKey(app, agent, body.client_event_id)).toHaveLength(0);
    return res;
  }

  describe('happy path', () => {
    it('201, and every server-set field comes from the token and the clock', async () => {
      const body = validEvent();
      const res = await postEvent(app, token, body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { event_id: string };
      expect(json).toEqual({
        event_id: expect.stringMatching(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/),
        status: 'accepted',
        job: 'extract',
      });
      const eventId = json.event_id;

      const [row] = await app.sql<Record<string, unknown>[]>`
        SELECT * FROM events WHERE event_id = ${eventId}`;
      expect(row).toMatchObject({
        event_id: eventId,
        schema_version: 1,
        kind: 'message',
        role: 'user',
        source_client: agent,
        agent_id: agent,
        token_id: tokenId,
        client_event_id: body.client_event_id,
        principal: 'owner',
        session_id: 'sess-test',
        observed_at: new Date('2026-10-21T19:05:09Z'),
        observed_tz: 'America/Chicago',
        received_at: RECEIVED_AT,
        clock_flags: [],
        hash_alg: 'sha256',
        content_type: 'text/plain',
        scope_hint: null,
        scope_id: 'personal',
        sensitivity: 'normal',
        trust_tier: 'user_typed',
        tainted: false,
        explicit_remember: false,
        refs_event_ids: [],
        redactions: [],
        metadata: { cwd: '/home/u/repo', hook: 'UserPromptSubmit' },
      });

      const [content] = await app.sql<{ body: string }[]>`
        SELECT body FROM event_content WHERE event_id = ${eventId}`;
      expect(content?.body).toBe(body.content);
      const hash = row?.content_hash as Buffer;
      expect(hash).toHaveLength(32);
      expect(hash.equals(createHash('sha256').update(String(body.content), 'utf8').digest())).toBe(
        true,
      );

      const jobs = await app.sql`
        SELECT kind, ref_id, status FROM jobs WHERE ref_id = ${eventId}`;
      expect(jobs).toEqual([{ kind: 'extract', ref_id: eventId, status: 'queued' }]);

      const acts = await app.sql`
        SELECT kind, actor, token_id, request_id, target_kind, target_id, event_ids, claim_ids,
               old_value, new_value, reason, details
        FROM activity_log WHERE target_id = ${eventId}`;
      expect(acts).toEqual([
        {
          kind: 'event_append',
          actor: agent,
          token_id: tokenId,
          request_id: res.headers.get('x-request-id'),
          target_kind: 'event',
          target_id: eventId,
          event_ids: [eventId],
          claim_ids: [],
          old_value: null,
          new_value: null,
          reason: null,
          details: {
            kind: 'message',
            role: 'user',
            sensitivity: 'normal',
            clock_flags: [],
            redactions: [],
            content_chars: String(body.content).length,
          },
        },
      ]);

      expect(requestLog(app, res)).toMatchObject({
        status: 201,
        agent_id: agent,
        token_id: tokenId,
        ingest: 'created',
        event_id: eventId,
      });
    });

    it('stores content as NFC and hashes that', async () => {
      const res = await postEvent(app, token, validEvent({ content: 'café' }));
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] = await app.sql<{ body: string; content_hash: Buffer }[]>`
        SELECT c.body, e.content_hash FROM events e JOIN event_content c USING (event_id)
        WHERE event_id = ${event_id}`;
      expect(row?.body).toBe('café');
      expect(row?.content_hash.equals(createHash('sha256').update('café').digest())).toBe(true);
    });

    it('sets clock flags from the injected clock', async () => {
      const res = await postEvent(app, token, validEvent({ observed_at: '2026-10-21T19:15:10Z' }));
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] = await app.sql<{ clock_flags: string[] }[]>`
        SELECT clock_flags FROM events WHERE event_id = ${event_id}`;
      expect(row?.clock_flags).toEqual(['drift', 'future']);
    });

    it('stores a junk observed_tz as NULL instead of rejecting the event', async () => {
      const res = await postEvent(app, token, validEvent({ observed_tz: 'Not/AZone' }));
      expect(res.status).toBe(201);
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] = await app.sql`SELECT observed_tz FROM events WHERE event_id = ${event_id}`;
      expect(row?.observed_tz).toBeNull();
    });

    it('assistant turns: agent_inferred, stored, and an extract job still queued', async () => {
      const res = await postEvent(app, token, validEvent({ role: 'assistant' }));
      expect(res.status).toBe(201);
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] = await app.sql`SELECT trust_tier FROM events WHERE event_id = ${event_id}`;
      expect(row?.trust_tier).toBe('agent_inferred');
      expect(await rowCounts(app, event_id)).toEqual({ events: 1, content: 1, jobs: 1, acts: 1 });
    });

    it('private events: stored as private, with an extract job queued', async () => {
      const res = await postEvent(app, token, validEvent({ sensitivity_hint: 'private' }));
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] = await app.sql`SELECT sensitivity FROM events WHERE event_id = ${event_id}`;
      expect(row?.sensitivity).toBe('private');
      expect(await rowCounts(app, event_id)).toEqual({ events: 1, content: 1, jobs: 1, acts: 1 });
    });
  });

  describe('attribution', () => {
    it.each(['agent_id', 'token_id', 'source_client', 'trust_tier'])(
      'a body that sets %s is a 422',
      async (field) => {
        const res = await rejected(validEvent({ [field]: 'someone-else' }), 422);
        expect(await res.json()).toEqual({
          error: 'invalid_request',
          issues: [{ path: '', code: 'unrecognized_keys' }],
        });
      },
    );

    it('with two tokens for one agent, the event records the token that made the call', async () => {
      const second = await staticToken(app, agent);
      const res = await postEvent(app, second.token, validEvent());
      const { event_id } = (await res.json()) as { event_id: string };
      const [row] =
        await app.sql`SELECT agent_id, token_id FROM events WHERE event_id = ${event_id}`;
      expect(row).toEqual({ agent_id: agent, token_id: second.tokenId });
    });
  });

  describe('idempotency (A6)', () => {
    it('a repeat gives 200, the same event_id, duplicate: true, and one row in each table', async () => {
      const body = validEvent();
      const first = await postEvent(app, token, body);
      const second = await postEvent(app, token, body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      const a = (await first.json()) as { event_id: string };
      expect(await second.json()).toEqual({
        event_id: a.event_id,
        status: 'accepted',
        job: 'extract',
        duplicate: true,
      });
      expect(await rowCounts(app, a.event_id)).toEqual({ events: 1, content: 1, jobs: 1, acts: 1 });
      expect(requestLog(app, second)).toMatchObject({ ingest: 'duplicate', event_id: a.event_id });
    });

    it('the same key with different content: 200, nothing new stored, logged duplicate_mismatch', async () => {
      const body = validEvent({ content: 'the original text' });
      const first = await postEvent(app, token, body);
      const { event_id } = (await first.json()) as { event_id: string };
      const second = await postEvent(app, token, { ...body, content: 'a different text' });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { event_id: string }).event_id).toBe(event_id);
      const [content] = await app.sql<{ body: string }[]>`
        SELECT body FROM event_content WHERE event_id = ${event_id}`;
      expect(content?.body).toBe('the original text');
      expect(await rowCounts(app, event_id)).toEqual({ events: 1, content: 1, jobs: 1, acts: 1 });
      expect(requestLog(app, second)).toMatchObject({ ingest: 'duplicate_mismatch', event_id });
    });

    it('the same key from another agent is a second event', async () => {
      const body = validEvent();
      const a = (await (await postEvent(app, token, body)).json()) as { event_id: string };
      const res = await postEvent(app, otherToken, body);
      expect(res.status).toBe(201);
      const b = (await res.json()) as { event_id: string };
      expect(b.event_id).not.toBe(a.event_id);
    });

    it('ten parallel posts of one key: one 201, nine 200s, one row in each table', async () => {
      const body = validEvent();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => postEvent(app, token, body)),
      );
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
      const ids = new Set(
        await Promise.all(
          responses.map(async (r) => ((await r.json()) as { event_id: string }).event_id),
        ),
      );
      expect(ids.size).toBe(1);
      const [eventId] = [...ids];
      expect(await rowCounts(app, String(eventId))).toEqual({
        events: 1,
        content: 1,
        jobs: 1,
        acts: 1,
      });
    });
  });

  describe('secrets (A16)', () => {
    const s = fakeSecrets();
    const password = `hunter2${'hunter2'}`;
    const secrets = [s.skKey, s.jwt, password, s.githubToken];
    const content = `My preferred package manager is pnpm. key ${s.skKey} jwt ${s.jwt} password=${password}`;

    /** Every place a secret could have landed, as text. */
    async function everywhere(extra: string[] = []): Promise<string> {
      const [db] = await app.sql<{ text: string }[]>`
        SELECT concat_ws(' ',
          (SELECT string_agg(row_to_json(e)::text, ' ') FROM events e),
          (SELECT string_agg(row_to_json(c)::text, ' ') FROM event_content c),
          (SELECT string_agg(row_to_json(a)::text, ' ') FROM activity_log a),
          (SELECT string_agg(row_to_json(j)::text, ' ') FROM jobs j)) AS text`;
      return [db?.text ?? '', app.logLines.join('\n'), ...extra].join('\n');
    }

    it('the stored body keeps the text and loses the secrets, everywhere', async () => {
      const res = await postEvent(
        app,
        token,
        validEvent({ content, metadata: { note: `token is ${s.githubToken}`, cwd: '/r' } }),
      );
      expect(res.status).toBe(201);
      const responseText = await res.text();
      const { event_id } = JSON.parse(responseText) as { event_id: string };

      const [row] = await app.sql<
        { body: string; redactions: unknown; content_hash: Buffer; metadata: unknown }[]
      >`
        SELECT c.body, e.redactions, e.content_hash, e.metadata
        FROM events e JOIN event_content c USING (event_id) WHERE event_id = ${event_id}`;
      expect(row?.body).toBe(
        'My preferred package manager is pnpm. key [REDACTED:api_key] jwt [REDACTED:jwt] ' +
          'password=[REDACTED:password]',
      );
      expect(row?.redactions).toEqual([
        { kind: 'api_key', count: 2 },
        { kind: 'jwt', count: 1 },
        { kind: 'password', count: 1 },
      ]);
      expect(row?.metadata).toEqual({ note: 'token is [REDACTED:api_key]', cwd: '/r' });
      expect(row?.content_hash.equals(createHash('sha256').update(row.body).digest())).toBe(true);

      const [act] = await app.sql<{ details: { redactions: unknown } }[]>`
        SELECT details FROM activity_log WHERE target_id = ${event_id}`;
      expect(act?.details.redactions).toEqual(row?.redactions);

      const text = await everywhere([responseText]);
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED:jwt]');
    });

    it('no secret reaches the logs or a response after a 422 or a 413', async () => {
      const r422 = await rejected(validEvent({ content, role: 'tool' }), 422);
      const r413 = await rejected(
        validEvent({
          content: `${content} ${'x'.repeat(100_001)}`,
          metadata: { k: s.githubToken },
        }),
        413,
      );
      const text = await everywhere([await r422.text(), await r413.text()]);
      for (const secret of secrets) expect(text).not.toContain(secret);
    });
  });

  describe('401', () => {
    async function expect401(res: Response) {
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="nacre"');
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }

    it('no token', async () => {
      const body = validEvent();
      await expect401(await postEvent(app, null, body));
      expect(await eventsForKey(app, agent, body.client_event_id)).toHaveLength(0);
    });

    it('a malformed header', async () => {
      await expect401(await postEvent(app, null, validEvent(), { Authorization: 'Bearer nope' }));
    });

    it('a revoked token', async () => {
      const revoked = await staticToken(app, agent);
      await revokeToken(app.sql, revoked.tokenId);
      await expect401(await postEvent(app, revoked.token, validEvent()));
    });

    it('a token in the query string, even next to a valid header', async () => {
      const res = await fetch(new URL(`/v1/events?access_token=${token}`, app.base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(validEvent()),
      });
      await expect401(res);
    });

    it('an OAuth access token (A17.5: /v1 takes static tokens only)', async () => {
      const access = await oauthToken(app, agent, { kind: 'oauth_access' });
      await expect401(await postEvent(app, access, validEvent()));
    });
  });

  describe('403', () => {
    it('a foreign Origin is refused; an allowed one passes', async () => {
      const res = await postEvent(app, token, validEvent(), { Origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'forbidden' });
      const ok = await postEvent(app, token, validEvent(), { Origin: PUBLIC_API_URL });
      expect(ok.status).toBe(201);
    });

    it('a token without the write right: 403, logged, no activity row', async () => {
      const minted = mintToken(app.pepper);
      await app.sql`
        INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, rights)
        VALUES (${minted.tokenId}, ${agent}, ${minted.secretHash}, 'static', ${['read']})`;
      const body = validEvent();
      const res = await rejected(body, 403, minted.token);
      expect(await res.json()).toEqual({ error: 'forbidden' });
      expect(requestLog(app, res)).toMatchObject({ ingest: 'rejected:no_write_right' });
      const acts = await app.sql`
        SELECT 1 FROM activity_log WHERE request_id = ${res.headers.get('x-request-id')}`;
      expect(acts).toHaveLength(0);
    });
  });

  describe('400', () => {
    const raw = (body: string, contentType = 'application/json') =>
      fetch(new URL('/v1/events', app.base), {
        method: 'POST',
        headers: { 'content-type': contentType, Authorization: `Bearer ${token}` },
        body,
      });

    it.each([
      ['not JSON', '{"client_event_id": ', 'application/json'],
      ['the wrong content type', JSON.stringify(validEvent()), 'text/plain'],
      ['a JSON array', JSON.stringify([validEvent()]), 'application/json'],
      ['a JSON string', '"event"', 'application/json'],
      ['JSON null', 'null', 'application/json'],
    ])('%s', async (_name, body, contentType) => {
      const res = await raw(body, contentType);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_json' });
      expect(requestLog(app, res)).toMatchObject({ ingest: 'rejected:invalid_json' });
    });

    it('a charset on the content type is fine', async () => {
      const res = await raw(JSON.stringify(validEvent()), 'application/json; charset=utf-8');
      expect(res.status).toBe(201);
    });
  });

  describe('422', () => {
    it.each([
      ['client_event_id', { client_event_id: 'has space' }],
      ['kind', { kind: 'remember' }],
      ['role', { role: 'tool' }],
      ['session_id', { session_id: 'a b' }],
      ['observed_at', { observed_at: '2026-10-21 14:05:09' }],
      ['observed_tz', { observed_tz: 5 }],
      ['content', { content: 5 }],
      ['scope_hint', { scope_hint: 's'.repeat(101) }],
      ['sensitivity_hint', { sensitivity_hint: 'secret' }],
      ['metadata', { metadata: [1] }],
      ['', { unknown_field: 1 }],
      ['content', { content: '' }],
      ['content', { content: '  \n ' }],
      ['content', { content: 'a\u0000b' }],
      ['metadata', { metadata: { 'k\u0000': 1 } }],
      ['content', { content: 'a\ud800' }],
    ])('%s: %j', async (path, overrides) => {
      const body = validEvent({ client_event_id: `bad:${Math.random()}`, ...overrides });
      const res = await rejected(body, 422);
      const json = (await res.json()) as { error: string; issues: { path: string }[] };
      expect(json.error).toBe('invalid_request');
      expect(json.issues.map((i) => i.path)).toEqual([path]);
      expect(requestLog(app, res)).toMatchObject({ ingest: 'rejected:invalid_request' });
    });
  });

  describe('413', () => {
    it('a 600 KiB body with a Content-Length', async () => {
      const body = validEvent({ content: 'x'.repeat(600 * 1024) });
      const res = await rejected(body, 413);
      expect(await res.json()).toEqual({ error: 'payload_too_large', field: 'body' });
      expect(requestLog(app, res)).toMatchObject({ ingest: 'rejected:body_too_large' });
    });

    it('a 600 KiB chunked body (no Content-Length)', async () => {
      // node:http, not fetch: the server answers 413 mid-upload and closes, and fetch reports that
      // as a network error, while curl (the hook) and node:http read the response.
      const body = validEvent({ content: 'x'.repeat(600 * 1024) });
      const res = await postChunked(app, token, Buffer.from(JSON.stringify(body)));
      expect(res.status).toBe(413);
      expect(res.chunked).toBe(true);
      expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large', field: 'body' });
      expect(await eventsForKey(app, agent, body.client_event_id)).toHaveLength(0);
    });

    it('100,001 characters of content; exactly 100,000 passes', async () => {
      const over = await rejected(validEvent({ content: 'a'.repeat(100_001) }), 413);
      expect(await over.json()).toEqual({ error: 'payload_too_large', field: 'content' });
      expect(requestLog(app, over)).toMatchObject({ ingest: 'rejected:content_too_large' });
      const exact = await postEvent(app, token, validEvent({ content: 'a'.repeat(100_000) }));
      expect(exact.status).toBe(201);
    });

    it('9 KiB of metadata', async () => {
      const res = await rejected(validEvent({ metadata: { a: 'x'.repeat(9 * 1024) } }), 413);
      expect(await res.json()).toEqual({ error: 'payload_too_large', field: 'metadata' });
    });
  });

  describe('routing and the request log', () => {
    it('POST only', async () => {
      const res = await fetch(new URL('/v1/events', app.base), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
    });

    it('no log line carries content, body or metadata, or any posted text', () => {
      const lines = parseLines(app);
      expect(lines.length).toBeGreaterThan(20);
      for (const line of lines) {
        for (const key of ['content', 'body', 'metadata']) expect(line).not.toHaveProperty(key);
      }
      const text = app.logLines.join('\n');
      for (const posted of ['preferred package manager', 'the original text', 'UserPromptSubmit']) {
        expect(text).not.toContain(posted);
      }
    });
  });
});

describe.skipIf(!appDatabaseUrl)('POST /v1/events: rate limit (429)', () => {
  let app: TestApp;
  const agent = testAgent('rl');
  const otherAgent = testAgent('rl2');
  let token: string;
  let otherToken: string;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl, { eventLimits: { perMinute: 3 } });
    ({ token } = await staticToken(app, agent));
    ({ token: otherToken } = await staticToken(app, otherAgent));
  });
  afterAll(() => app?.close());

  it('the 4th attempt in a minute is a 429; 401s and 403s never use a slot', async () => {
    // These never reach the limiter.
    expect((await postEvent(app, null, validEvent())).status).toBe(401);
    expect((await postEvent(app, `${token.slice(0, -2)}xx`, validEvent())).status).toBe(401);
    const minted = mintToken(app.pepper);
    await app.sql`
      INSERT INTO agent_tokens (token_id, agent_id, secret_hash, kind, rights)
      VALUES (${minted.tokenId}, ${agent}, ${minted.secretHash}, 'static', ${['read']})`;
    expect((await postEvent(app, minted.token, validEvent())).status).toBe(403);
    expect(
      (await postEvent(app, token, validEvent(), { Origin: 'https://evil.example' })).status,
    ).toBe(403);

    // Three slots: good and bad attempts alike.
    expect((await postEvent(app, token, validEvent())).status).toBe(201);
    expect((await postEvent(app, token, validEvent({ role: 'tool' }))).status).toBe(422);
    expect((await postEvent(app, token, 'not json')).status).toBe(400);

    const s = fakeSecrets();
    const body = validEvent({ content: `key ${s.skKey}` });
    const limited = await postEvent(app, token, body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toEqual({ error: 'too_many_requests' });
    expect(requestLog(app, limited)).toMatchObject({ ingest: 'rejected:rate_limited' });
    expect(await eventsForKey(app, agent, body.client_event_id)).toHaveLength(0);
    expect(app.logLines.join('\n')).not.toContain(s.skKey);

    // Per agent: another agent's token still gets in.
    expect((await postEvent(app, otherToken, validEvent())).status).toBe(201);
  });
});
