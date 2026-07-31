import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Nacre } from '../nacre.js';
import { LocalBackend } from '../local.js';

describe('Nacre — local mode', () => {
  let nacre: Nacre;

  before(() => {
    nacre = new Nacre({ path: ':memory:', embedder: 'mock' });
  });

  after(async () => {
    await nacre.close();
  });

  describe('backend selection', () => {
    it('selects LocalBackend for path option', () => {
      const n = new Nacre({ path: ':memory:' });
      assert.ok(n instanceof Nacre);
      n.close();
    });

    it('throws without path or url', () => {
      assert.throws(() => new Nacre({} as never), /requires either path/);
    });
  });

  describe('scope resolution (V2-2 D3)', () => {
    it('honors memory.defaultScope from nacre.config.json, same as MCP/API', async () => {
      const root = mkdtempSync(join(tmpdir(), 'nacre-sdk-scope-'));
      const n = new Nacre({ path: join(root, 'graph.db'), embedder: 'mock' });
      try {
        writeFileSync(
          join(root, 'nacre.config.json'),
          JSON.stringify({ memory: { defaultScope: 'project/sdk' } }),
        );
        const defaulted = await n.remember('Config-scoped memory');
        assert.strictEqual(defaulted.scope, 'project/sdk');
        const explicit = await n.remember('User-scoped memory', { scope: 'user' });
        assert.strictEqual(explicit.scope, 'user', 'explicit scope beats the config default');
      } finally {
        await n.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('remember + recall', () => {
    it('remembers a fact and recalls it', async () => {
      const mem = await nacre.remember('TypeScript is a typed superset of JavaScript');
      assert.ok(mem.id);
      assert.strictEqual(mem.label, 'TypeScript is a typed superset of JavaScript');
      assert.strictEqual(mem.type, 'concept');

      const results = await nacre.recall('TypeScript');
      assert.ok(results.length > 0);
      const found = results.find((r) => r.id === mem.id);
      assert.ok(found, 'Should find the remembered memory');
    });

    it('remembers with type and importance', async () => {
      const mem = await nacre.remember('Deployed v2 to production', {
        type: 'event',
        importance: 0.9,
      });
      assert.strictEqual(mem.type, 'event');
    });

    it('links to existing entities', async () => {
      await nacre.remember('Vite', { type: 'fact' });
      const mem = await nacre.remember('Vite is fast', { entities: ['Vite'] });
      assert.ok(mem.id);
    });
  });

  describe('recall options', () => {
    it('respects limit', async () => {
      const results = await nacre.recall('TypeScript', { limit: 1 });
      assert.ok(results.length <= 1);
    });

    it('returns empty for non-matching query', async () => {
      const results = await nacre.recall('xyznonexistent123456');
      assert.strictEqual(results.length, 0);
    });
  });

  describe('brief', () => {
    it('returns briefing text', async () => {
      const text = await nacre.brief();
      assert.ok(typeof text === 'string');
      assert.ok(text.length > 0);
    });

    it('accepts focus option', async () => {
      const text = await nacre.brief({ focus: 'TypeScript' });
      assert.ok(typeof text === 'string');
    });
  });

  describe('lesson', () => {
    it('records a lesson', async () => {
      const mem = await nacre.lesson('Always validate input before processing');
      assert.ok(mem.id);
      assert.strictEqual(mem.type, 'insight');
      assert.strictEqual(mem.statement, 'Always validate input before processing');
    });

    it('records a lesson with context and category', async () => {
      const mem = await nacre.lesson('Use strict mode', {
        context: 'TypeScript config',
        category: 'preference',
      });
      assert.ok(mem.id);
    });
  });

  describe('feedback', () => {
    it('reinforces a memory with positive rating', async () => {
      const mem = await nacre.remember('Important fact');
      await nacre.feedback(mem.id, { rating: 1, reason: 'very useful' });
    });

    it('weakens a memory with negative rating', async () => {
      const mem = await nacre.remember('Less important');
      await nacre.feedback(mem.id, { rating: -1 });
    });

    it('throws for missing memory', async () => {
      await assert.rejects(() => nacre.feedback('nonexistent', { rating: 1 }), /not found/i);
    });
  });

  describe('forget', () => {
    it('forgets a memory', async () => {
      const mem = await nacre.remember('Temporary note');
      await nacre.forget(mem.id);
      const results = await nacre.recall('Temporary note');
      const found = results.find((r) => r.id === mem.id);
      assert.strictEqual(found, undefined);
    });

    it('throws for missing memory', async () => {
      await assert.rejects(() => nacre.forget('nonexistent'), /not found/i);
    });
  });

  describe('nodes', () => {
    it('lists all nodes', async () => {
      const all = await nacre.nodes();
      assert.ok(all.length > 0);
    });

    it('filters by type', async () => {
      const lessons = await nacre.nodes({ type: 'lesson' });
      for (const n of lessons) {
        assert.strictEqual(n.type, 'lesson');
      }
    });
  });

  describe('stats', () => {
    it('returns graph statistics', async () => {
      const s = await nacre.stats();
      assert.ok(s.nodeCount > 0);
      assert.ok(typeof s.edgeCount === 'number');
      assert.ok(typeof s.embeddingCount === 'number');
    });
  });
});

describe('LocalBackend', () => {
  it('throws without path', () => {
    assert.throws(() => new LocalBackend({} as never), /requires path/);
  });
});
