import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('worker', () => {
  it('logs, then exits 0 on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
      env: { ...process.env, LOG_LEVEL: 'info', WORKER_POLL_MS: '50' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let output = '';
    child.stdout.setEncoding('utf8');
    const started = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('worker started')) resolve();
      });
    });

    await started;
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');

    expect(code).toBe(0);
    expect(output).toContain('shutdown requested');
    expect(output).toContain('worker stopped');
  }, 15_000);
});
