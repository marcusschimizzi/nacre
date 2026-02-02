import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashFile, scanDirectories, detectChanges } from '../discover.js';

const TMP = resolve(import.meta.dirname, '..', '..', '..', '..', 'tmp-parser-test');

before(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true });
  }
  mkdirSync(TMP, { recursive: true });
  writeFileSync(resolve(TMP, 'a.md'), 'Hello world');
  writeFileSync(resolve(TMP, 'b.md'), 'Another file');
  mkdirSync(resolve(TMP, 'sub'), { recursive: true });
  writeFileSync(resolve(TMP, 'sub', 'c.md'), 'Nested file');
  writeFileSync(resolve(TMP, 'skip.txt'), 'Not markdown');
});

after(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true });
  }
});

describe('hashFile', () => {
  it('produces consistent SHA-256 hash', async () => {
    const hash1 = await hashFile(resolve(TMP, 'a.md'));
    const hash2 = await hashFile(resolve(TMP, 'a.md'));
    assert.equal(hash1, hash2);
  });

  it('produces different hashes for different content', async () => {
    const hashA = await hashFile(resolve(TMP, 'a.md'));
    const hashB = await hashFile(resolve(TMP, 'b.md'));
    assert.notEqual(hashA, hashB);
  });
});

describe('scanDirectories', () => {
  it('finds all .md files recursively', async () => {
    const files = await scanDirectories([TMP]);
    assert.equal(files.length, 3);
    const fileNames = files.map((f) => f.replace(TMP, ''));
    assert.ok(fileNames.some((f) => f.includes('a.md')));
    assert.ok(fileNames.some((f) => f.includes('b.md')));
    assert.ok(fileNames.some((f) => f.includes('c.md')));
  });

  it('skips non-md files', async () => {
    const files = await scanDirectories([TMP]);
    const hasTxt = files.some((f) => f.endsWith('.txt'));
    assert.equal(hasTxt, false);
  });

  it('handles single file input', async () => {
    const files = await scanDirectories([resolve(TMP, 'a.md')]);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('a.md'));
  });
});

describe('detectChanges', () => {
  it('detects all files as new when no processed files exist', async () => {
    const files = await scanDirectories([TMP]);
    const result = await detectChanges(files, []);
    assert.equal(result.newFiles.length, 3);
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.unchangedFiles.length, 0);
  });

  it('detects unchanged files', async () => {
    const files = await scanDirectories([TMP]);
    const processedFiles = await Promise.all(
      files.map(async (file) => ({
        path: file,
        hash: await hashFile(file),
        lastProcessed: '2026-02-02',
      })),
    );
    const result = await detectChanges(files, processedFiles);
    assert.equal(result.newFiles.length, 0);
    assert.equal(result.changedFiles.length, 0);
    assert.equal(result.unchangedFiles.length, 3);
  });

  it('detects changed files', async () => {
    const files = await scanDirectories([TMP]);
    const processedFiles = await Promise.all(
      files.map(async (file) => ({
        path: file,
        hash: 'wrong-hash-for-' + file,
        lastProcessed: '2026-02-02',
      })),
    );
    const result = await detectChanges(files, processedFiles);
    assert.equal(result.newFiles.length, 0);
    assert.equal(result.changedFiles.length, 3);
    assert.equal(result.unchangedFiles.length, 0);
  });
});
