import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { logActivity } from '../src/shared/activity.js';
import { startTestApp, staticToken, type TestApp, testAgent } from './helpers/app.js';
import { postEvent, validEvent } from './helpers/events.js';

// Its own file, because it mocks a module: the real logActivity, wrapped so one call can fail.
vi.mock('../src/shared/activity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/shared/activity.js')>();
  return { ...actual, logActivity: vi.fn(actual.logActivity) };
});

const appDatabaseUrl = inject('appDatabaseUrl');

describe.skipIf(!appDatabaseUrl)('POST /v1/events: one transaction', () => {
  let app: TestApp;
  const agent = testAgent('rb');
  let token: string;

  beforeAll(async () => {
    app = await startTestApp(appDatabaseUrl);
    ({ token } = await staticToken(app, agent));
  });
  afterAll(() => app?.close());

  const counts = async () => {
    const [row] = await app.sql<{ events: number; content: number; jobs: number; acts: number }[]>`
      SELECT (SELECT count(*)::int FROM events WHERE agent_id = ${agent}) AS events,
             (SELECT count(*)::int FROM event_content c JOIN events e USING (event_id)
               WHERE e.agent_id = ${agent}) AS content,
             -- This agent's events' jobs, plus orphans (a job whose event doesn't exist), which
             -- a broken rollback would leave; other test files share the database.
             (SELECT count(*)::int FROM jobs j
               WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.event_id = j.ref_id)
                  OR j.ref_id IN (SELECT event_id FROM events WHERE agent_id = ${agent})) AS jobs,
             (SELECT count(*)::int FROM activity_log
               WHERE kind = 'event_append' AND actor = ${agent}) AS acts`;
    return row;
  };

  it('a failure in the last step (logActivity) rolls everything back and leaks nothing', async () => {
    const content = 'a remark only this test makes, about rollbacks';
    const body = validEvent({ content });
    const before = await counts();
    vi.mocked(logActivity).mockRejectedValueOnce(new Error(`boom ${content}`));

    const res = await postEvent(app, token, body);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    expect(vi.mocked(logActivity)).toHaveBeenCalled();
    expect(await counts()).toEqual(before);

    const lines = app.logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const error = lines.find((l) => l.msg === 'v1: request failed');
    expect(error).toMatchObject({
      level: 50,
      request_id: res.headers.get('x-request-id'),
      err_name: 'Error',
    });
    expect(Object.keys(error ?? {}).sort()).toEqual(
      ['err_name', 'level', 'msg', 'request_id', 'service', 'time'].sort(),
    );
    const text = app.logLines.join('\n');
    expect(text).not.toContain('boom');
    expect(text).not.toContain(content);

    // The key wasn't burned: the same payload now goes in.
    const retry = await postEvent(app, token, body);
    expect(retry.status).toBe(201);
    const after = await counts();
    expect(after).toEqual({
      events: (before?.events ?? 0) + 1,
      content: (before?.content ?? 0) + 1,
      jobs: (before?.jobs ?? 0) + 1,
      acts: (before?.acts ?? 0) + 1,
    });
  });
});
