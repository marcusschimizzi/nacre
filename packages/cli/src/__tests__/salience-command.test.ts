import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serializeMemoryFile, type MemoryObject } from '@nacre/core';
import { executeSalienceCommand } from '../commands/salience.js';

const AT = '2026-07-23T12:00:00.000Z';

function canonical(id: string, type: MemoryObject['type']): MemoryObject {
  return {
    id,
    type,
    scope: 'project/nacre',
    confidence: 0.8,
    sensitivity: 'low',
    created: '2026-07-01',
    lastConfirmed: '2026-07-01',
    sources: [`synthetic:${id}`],
    sourceAuthority: 'direct_user',
    trust: 1,
    eventTime: '2026-07-01T10:00:00.000Z',
    salience: { reinforcementCount: 99 },
    body: `${type} memory ${id}.`,
  };
}

function seed(root: string): void {
  const dir = join(root, 'projects', 'nacre', 'decisions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'b.md'), serializeMemoryFile(canonical('mem_bbbbbbbbbbbb', 'claim')));
  writeFileSync(join(dir, 'a.md'), serializeMemoryFile(canonical('mem_aaaaaaaaaaaa', 'decision')));
}

function snapshot(root: string): Array<[string, string]> {
  const walk = (dir: string, prefix = ''): Array<[string, string]> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path, rel) : [[rel, readFileSync(path, 'utf8')]];
    });
  return walk(root).sort(([a], [b]) => a.localeCompare(b));
}

describe('salience command surface', () => {
  it('ranks canonical memories deterministically without mutating the memory root', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacre-cli-salience-'));
    seed(root);
    const before = snapshot(root);

    const first = executeSalienceCommand({ memoryDir: root, evaluatedAt: AT, limit: 10 });
    const second = executeSalienceCommand({ memoryDir: root, evaluatedAt: AT, limit: 10 });

    assert.deepEqual(second, first);
    assert.equal(first.version, 'nacre.salience.v1');
    assert.equal(first.results.length, 2);
    assert.equal(first.results[0].memoryId, 'mem_aaaaaaaaaaaa');
    assert.deepEqual(snapshot(root), before);
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the built CLI parser, validates --at, emits stable JSON, and writes nothing', () => {
    execFileSync('npm', ['run', 'build', '-w', '@nacre/core'], {
      cwd: join(import.meta.dirname, '../../../..'),
      stdio: 'pipe',
    });
    execFileSync('npm', ['run', 'build', '-w', '@nacre/cli'], {
      cwd: join(import.meta.dirname, '../../../..'),
      stdio: 'pipe',
    });
    const root = mkdtempSync(join(tmpdir(), 'nacre-cli-salience-process-'));
    seed(root);
    const before = snapshot(root);
    const bin = join(import.meta.dirname, '../../dist/index.js');

    const run = spawnSync(
      process.execPath,
      [bin, 'salience', '--memory-dir', root, '--at', AT, '--limit', '1'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout) as {
      count: number;
      results: Array<{ memoryId: string }>;
    };
    assert.equal(output.count, 2);
    assert.deepEqual(
      output.results.map((result) => result.memoryId),
      ['mem_aaaaaaaaaaaa'],
    );
    assert.deepEqual(snapshot(root), before);

    const invalid = spawnSync(
      process.execPath,
      [bin, 'salience', '--memory-dir', root, '--at', '2026-07-23'],
      { encoding: 'utf8' },
    );
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /strict ISO/i);
    assert.deepEqual(snapshot(root), before);

    const malformedRoot = mkdtempSync(join(tmpdir(), 'nacre-cli-salience-malformed-'));
    writeFileSync(
      join(malformedRoot, 'bad.md'),
      '---\nid: mem_121212121212\ntype: fact\nscope: user\nconfidence: .nan\ncreated: 2026-07-01\nsources:\n  - synthetic:bad\n---\n\nMalformed confidence.\n',
    );
    const malformedBefore = snapshot(malformedRoot);
    const malformed = spawnSync(
      process.execPath,
      [bin, 'salience', '--memory-dir', malformedRoot, '--at', AT],
      { encoding: 'utf8' },
    );
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /confidence/i);
    assert.deepEqual(snapshot(malformedRoot), malformedBefore);

    rmSync(malformedRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});
