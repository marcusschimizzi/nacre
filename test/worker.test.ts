import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createSql, type Sql } from '../src/shared/db/sql.js';
import { seedEvents, seeder } from './helpers/worker.js';

const appDatabaseUrl = inject('appDatabaseUrl');

/** Starts `src/worker/main.ts` with only the given variables set on top of PATH and HOME. */
function startWorker(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (output.includes(text)) resolve();
      };
      child.stdout?.on('data', check);
      child.once('exit', () => reject(new Error(`exited before logging "${text}"`)));
      check();
    });
  return { child, waitFor, output: () => output };
}

async function stop(child: ChildProcess): Promise<{ code: number | null; ms: number }> {
  const t0 = performance.now();
  child.kill('SIGTERM');
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, ms: performance.now() - t0 };
}

describe.skipIf(!appDatabaseUrl)('worker process', () => {
  let sql: Sql;
  beforeAll(() => {
    sql = createSql(appDatabaseUrl, { max: 2 });
  });
  afterAll(() => sql?.end());

  it('without OPENAI_API_KEY: starts, warns, claims nothing, exits 0 on SIGTERM', async () => {
    const s = await seeder(sql, 'idle');
    const [eventId = ''] = await seedEvents(s, [{ content: 'I prefer pnpm for every project.' }]);
    const worker = startWorker({ DATABASE_URL: appDatabaseUrl, WORKER_POLL_MS: '50' });
    await worker.waitFor('extraction disabled: OPENAI_API_KEY is not set');
    // Give an (incorrectly) active loop time to claim.
    await new Promise((r) => setTimeout(r, 300));
    const [job] = await sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM jobs WHERE kind = 'extract' AND ref_id = ${eventId}`;
    expect(job).toEqual({ status: 'queued', attempts: 0 });

    const { code } = await stop(worker.child);
    expect(code).toBe(0);
    const out = worker.output();
    expect(out).toContain('worker started');
    expect(out).toContain('"openai":"missing"');
    expect(out).toContain('schema is current');
    expect(out).toContain('shutdown requested');
    expect(out).toContain('worker stopped');
  }, 20_000);

  it('with an unreachable database: waits for the schema, then exits 0 within 5 s of SIGTERM', async () => {
    const worker = startWorker({
      DATABASE_URL: 'postgres://nacre_app@127.0.0.1:1/nacre?sslmode=disable',
    });
    await worker.waitFor('waiting for schema');
    // Still running: it waits rather than crashing.
    expect(worker.child.exitCode).toBeNull();
    const { code, ms } = await stop(worker.child);
    expect(code).toBe(0);
    expect(ms).toBeLessThan(5000);
    expect(worker.output()).toContain('"sqlstate":"ECONNREFUSED"');
    expect(worker.output()).toContain('worker stopped');
    expect(worker.output()).not.toContain('schema is current');
  }, 20_000);

  it('never logs the key', async () => {
    const key = `sk-${'proj-'}${'k3Y'.repeat(16)}`;
    const worker = startWorker({
      DATABASE_URL: 'postgres://nacre_app@127.0.0.1:1/nacre?sslmode=disable',
      OPENAI_API_KEY: key,
    });
    await worker.waitFor('waiting for schema');
    await stop(worker.child);
    expect(worker.output()).toContain('"openai":"configured"');
    expect(worker.output()).not.toContain(key);
  }, 20_000);
});
