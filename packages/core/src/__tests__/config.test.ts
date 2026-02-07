import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, resolveProvider } from '../config.js';
import { MockEmbedder, OllamaEmbedder, OpenAIEmbedder } from '../embeddings.js';

describe('loadConfig', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'nacre-config-test-'));
    tmpDirs.push(d);
    return d;
  }

  it('returns empty config when no file exists', () => {
    const result = loadConfig('/tmp/nonexistent/graph.db');
    assert.deepEqual(result, {});
  });

  it('returns empty config for :memory:', () => {
    const result = loadConfig(':memory:');
    assert.deepEqual(result, {});
  });

  it('loads config from directory adjacent to graph file', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'nacre.config.json'), JSON.stringify({
      embeddings: { provider: 'mock' },
    }));
    const config = loadConfig(join(dir, 'graph.db'));
    assert.equal(config.embeddings?.provider, 'mock');
  });

  it('returns empty config for invalid JSON', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'nacre.config.json'), 'NOT JSON');
    const config = loadConfig(join(dir, 'graph.db'));
    assert.deepEqual(config, {});
  });
});

describe('resolveProvider', () => {
  const savedProvider = process.env.NACRE_EMBEDDING_PROVIDER;
  const savedApiKey = process.env.OPENAI_API_KEY;
  const tmpDirs: string[] = [];

  afterEach(() => {
    if (savedProvider !== undefined) process.env.NACRE_EMBEDDING_PROVIDER = savedProvider;
    else delete process.env.NACRE_EMBEDDING_PROVIDER;
    if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey;
    else delete process.env.OPENAI_API_KEY;

    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function makeTmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'nacre-resolve-test-'));
    tmpDirs.push(d);
    return d;
  }

  it('CLI flag takes priority', () => {
    const result = resolveProvider({ provider: 'mock' });
    assert.ok(result instanceof MockEmbedder);
  });

  it('provider: ollama returns OllamaEmbedder', () => {
    const result = resolveProvider({ provider: 'ollama' });
    assert.ok(result instanceof OllamaEmbedder);
  });

  it('provider: openai with apiKey returns OpenAIEmbedder', () => {
    const result = resolveProvider({ provider: 'openai', apiKey: 'test-key' });
    assert.ok(result instanceof OpenAIEmbedder);
  });

  it('unknown provider throws', () => {
    assert.throws(
      () => resolveProvider({ provider: 'banana' }),
      (err: Error) => {
        assert.match(err.message, /Unknown embedding provider.*banana/);
        return true;
      }
    );
  });

  it('allowNull returns null when no provider configured', () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    const result = resolveProvider({ allowNull: true });
    assert.equal(result, null);
  });

  it('env var NACRE_EMBEDDING_PROVIDER used as fallback', () => {
    process.env.NACRE_EMBEDDING_PROVIDER = 'mock';
    const result = resolveProvider({});
    assert.ok(result instanceof MockEmbedder);
  });

  it('config file used when no CLI flag', () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'nacre.config.json'), JSON.stringify({
      embeddings: { provider: 'mock' },
    }));
    const result = resolveProvider({ graphPath: join(dir, 'graph.db') });
    assert.ok(result instanceof MockEmbedder);
  });

  it('throws when no provider and allowNull not set', () => {
    delete process.env.NACRE_EMBEDDING_PROVIDER;
    assert.throws(
      () => resolveProvider({}),
      (err: Error) => {
        assert.match(err.message, /No embedding provider configured/);
        return true;
      }
    );
  });
});
