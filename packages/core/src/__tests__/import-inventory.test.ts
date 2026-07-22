import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inventoryOpenClawSessions } from '../import-inventory.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openclaw');

describe('OpenClaw canonical session inventory', () => {
  it('selects one primary logical session and audits reset and trajectory alternates', () => {
    const inventory = inventoryOpenClawSessions(fixtures, { recursive: false });
    const direct = inventory.sessions.find(
      (session) => session.sessionId === 'sess-synthetic-direct',
    );

    assert.ok(direct);
    assert.equal(direct.selected.path, join(fixtures, 'direct-session.jsonl'));
    assert.deepEqual(direct.excluded.map((entry) => entry.kind).sort(), ['reset', 'trajectory']);
    assert.ok(direct.excluded.every((entry) => entry.reason.length > 0));
    assert.equal(
      inventory.selectedFiles.includes(join(fixtures, 'session.trajectory.jsonl')),
      false,
    );
    assert.ok(inventory.sessions.some((session) => session.sessionId === 'sess-synthetic-repeat'));
    assert.ok(inventory.sessions.some((session) => session.sessionId === 'sess-synthetic-routed'));
  });

  it('honors non-recursive traversal and supports a single primary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nacre-inventory-'));
    try {
      const primary = join(root, 'primary.jsonl');
      const nested = join(root, 'nested');
      await mkdir(nested);
      const record = (id: string) =>
        `${JSON.stringify({ type: 'session', id })}\n${JSON.stringify({ type: 'message', id: 'm', message: { role: 'user', content: id } })}\n`;
      await writeFile(primary, record('top'));
      await writeFile(join(nested, 'nested.jsonl'), record('nested'));

      assert.deepEqual(inventoryOpenClawSessions(root, { recursive: false }).selectedFiles, [
        primary,
      ]);
      assert.equal(inventoryOpenClawSessions(root, { recursive: true }).selectedFiles.length, 2);
      assert.deepEqual(inventoryOpenClawSessions(primary).selectedFiles, [primary]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never selects alternate-only groups without an explicit forensic override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nacre-inventory-alternate-'));
    try {
      const trajectory = join(root, 'orphan.trajectory.jsonl');
      await writeFile(
        trajectory,
        `${JSON.stringify({ type: 'session', id: 'orphan' })}\n${JSON.stringify({ type: 'message', id: 'm', message: { role: 'user', content: 'forensic only' } })}\n`,
      );
      const normal = inventoryOpenClawSessions(root);
      assert.deepEqual(normal.selectedFiles, []);
      assert.equal(normal.excludedFiles[0].kind, 'trajectory');
      assert.deepEqual(inventoryOpenClawSessions(root, { forensic: true }).selectedFiles, [
        trajectory,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats ordinary names containing backup as primary and only explicit artifacts as alternates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nacre-inventory-conventions-'));
    try {
      const record = (id: string, content: string) =>
        `${JSON.stringify({ type: 'session', id })}\n${JSON.stringify({ type: 'message', id: 'm', message: { role: 'user', content } })}\n`;
      const primary = join(root, 'backup-plan.jsonl');
      const backup = join(root, 'session.jsonl.bak');
      await writeFile(primary, record('backup-plan', 'ordinary primary'));
      await writeFile(backup, record('backup-only', 'explicit backup artifact'));

      const inventory = inventoryOpenClawSessions(root);
      assert.deepEqual(inventory.selectedFiles, [primary]);
      assert.equal(inventory.sessions[0].selected.kind, 'primary');
      assert.equal(inventory.excludedFiles.find((file) => file.path === backup)?.kind, 'backup');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked source files instead of importing outside the archive root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nacre-inventory-symlink-'));
    const outside = join(root, '..', `outside-${Date.now()}.jsonl`);
    try {
      await writeFile(outside, `${JSON.stringify({ type: 'session', id: 'outside' })}\n`);
      await symlink(outside, join(root, 'linked.jsonl'));
      assert.throws(() => inventoryOpenClawSessions(root), /symlink/i);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('enforces explicit archive traversal, file, byte, line, and record limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nacre-inventory-limits-'));
    try {
      const nested = join(root, 'one', 'two');
      await mkdir(nested, { recursive: true });
      const record = `${JSON.stringify({ type: 'session', id: 'limited' })}\n${JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user', content: 'one' } })}\n`;
      const first = join(root, 'first.jsonl');
      await writeFile(first, record);
      await writeFile(join(root, 'second.jsonl'), record.replace('limited', 'limited-2'));
      await writeFile(join(nested, 'deep.jsonl'), record.replace('limited', 'deep'));

      assert.throws(
        () =>
          inventoryOpenClawSessions(root, { recursive: true, limits: { maxTraversalDepth: 1 } }),
        /traversal depth/i,
      );
      assert.throws(
        () => inventoryOpenClawSessions(root, { limits: { maxFiles: 1 } }),
        /file count/i,
      );
      assert.throws(
        () => inventoryOpenClawSessions(root, { limits: { maxAggregateBytes: 1 } }),
        /aggregate bytes/i,
      );
      assert.throws(
        () => inventoryOpenClawSessions(first, { limits: { maxFileBytes: 1 } }),
        /per-file bytes/i,
      );
      assert.throws(
        () => inventoryOpenClawSessions(first, { limits: { maxLineBytes: 8 } }),
        /line bytes/i,
      );
      assert.throws(
        () => inventoryOpenClawSessions(first, { limits: { maxRecords: 1 } }),
        /record count/i,
      );

      const inventory = inventoryOpenClawSessions(first);
      assert.equal(inventory.sessions[0].selected.content, record);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
