import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import {
  MockEmbedder,
  OnnxEmbedder,
  OpenAIEmbedder,
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
} from '../embeddings.js';

describe('MockEmbedder', () => {
  const embedder = new MockEmbedder(64);

  it('returns vectors of correct dimensions', async () => {
    const vec = await embedder.embed('hello world');
    assert.equal(vec.length, 64);
  });

  it('returns consistent vectors for the same input', async () => {
    const a = await embedder.embed('typescript');
    const b = await embedder.embed('typescript');
    assert.deepEqual(a, b);
  });

  it('returns different vectors for different inputs', async () => {
    const a = await embedder.embed('typescript');
    const b = await embedder.embed('python');
    assert.notDeepEqual(a, b);
  });

  it('returns unit-normalized vectors', async () => {
    const vec = await embedder.embed('test input');
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 1e-6, `norm was ${Math.sqrt(norm)}`);
  });

  it('embedBatch returns one vector per input', async () => {
    const results = await embedder.embedBatch(['a', 'b', 'c']);
    assert.equal(results.length, 3);
    assert.equal(results[0].length, 64);
  });

  it('has correct name and dimensions properties', () => {
    assert.equal(embedder.name, 'mock');
    assert.equal(embedder.dimensions, 64);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 1e-6);
  });

  it('computes correct similarity for known vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot = 4+10+18 = 32, |a| = sqrt(14), |b| = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    assert.ok(Math.abs(cosineSimilarity(a, b) - expected) < 1e-5);
  });

  it('returns 0 for zero vector', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    assert.equal(cosineSimilarity(a, b), 0);
  });

  it('throws on dimension mismatch', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    assert.throws(() => cosineSimilarity(a, b), /dimension mismatch/);
  });
});

describe('Float32Array <-> Buffer serialization', () => {
  it('roundtrips a vector correctly', () => {
    const original = new Float32Array([0.1, -0.5, 3.14159, 0, -1e10]);
    const buf = vectorToBuffer(original);
    const restored = bufferToVector(buf);
    assert.equal(restored.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.equal(restored[i], original[i]);
    }
  });

  it('roundtrips a large vector', () => {
    const original = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      original[i] = Math.sin(i) * 0.1;
    }
    const restored = bufferToVector(vectorToBuffer(original));
    assert.equal(restored.length, 768);
    for (let i = 0; i < 768; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 1e-7);
    }
  });
});

describe('SqliteStore embedding operations', () => {
  let store: SqliteStore;
  const embedder = new MockEmbedder(64);

  before(async () => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  it('putEmbedding + getEmbedding roundtrip preserves vector data', async () => {
    const vec = await embedder.embed('typescript is great');
    store.putEmbedding('n1', 'node', 'typescript is great', vec, 'mock');

    const result = store.getEmbedding('n1');
    assert.ok(result);
    assert.equal(result.id, 'n1');
    assert.equal(result.type, 'node');
    assert.equal(result.content, 'typescript is great');
    assert.equal(result.provider, 'mock');
    assert.equal(result.vector.length, 64);

    for (let i = 0; i < vec.length; i++) {
      assert.equal(result.vector[i], vec[i]);
    }
  });

  it('getEmbedding returns undefined for missing id', () => {
    assert.equal(store.getEmbedding('nonexistent'), undefined);
  });

  it('putEmbedding upserts on same id', async () => {
    const vec1 = await embedder.embed('version 1');
    store.putEmbedding('upsert1', 'node', 'version 1', vec1, 'mock');

    const vec2 = await embedder.embed('version 2');
    store.putEmbedding('upsert1', 'node', 'version 2', vec2, 'mock');

    const result = store.getEmbedding('upsert1');
    assert.ok(result);
    assert.equal(result.content, 'version 2');
  });

  it('searchSimilar returns results sorted by similarity', async () => {
    const texts = ['build tools for javascript', 'vite bundler fast', 'unrelated cooking recipe'];
    for (let i = 0; i < texts.length; i++) {
      const vec = await embedder.embed(texts[i]);
      store.putEmbedding(`search-${i}`, 'node', texts[i], vec, 'mock');
    }

    const queryVec = await embedder.embed('build tools for javascript');
    const results = store.searchSimilar(queryVec);

    assert.ok(results.length > 0);
    assert.equal(results[0].id, 'search-0');
    assert.ok(Math.abs(results[0].similarity - 1.0) < 1e-5);

    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].similarity >= results[i].similarity);
    }
  });

  it('searchSimilar respects type filter', async () => {
    const vec = await embedder.embed('episode content');
    store.putEmbedding('ep1', 'episode', 'episode content', vec, 'mock');

    const queryVec = await embedder.embed('episode content');
    const onlyEpisodes = store.searchSimilar(queryVec, { type: 'episode' });
    assert.ok(onlyEpisodes.every(r => r.type === 'episode'));
  });

  it('searchSimilar respects limit', async () => {
    const queryVec = await embedder.embed('anything');
    const results = store.searchSimilar(queryVec, { limit: 2 });
    assert.ok(results.length <= 2);
  });

  it('searchSimilar respects minSimilarity threshold', async () => {
    const queryVec = await embedder.embed('something very specific');
    const results = store.searchSimilar(queryVec, { minSimilarity: 0.99 });
    assert.ok(results.every(r => r.similarity >= 0.99));
  });

  it('deleteEmbedding removes the embedding', async () => {
    const vec = await embedder.embed('to be deleted');
    store.putEmbedding('del1', 'node', 'to be deleted', vec, 'mock');
    assert.ok(store.getEmbedding('del1'));

    store.deleteEmbedding('del1');
    assert.equal(store.getEmbedding('del1'), undefined);
  });

  it('embeddingCount returns correct count', () => {
    const count = store.embeddingCount();
    assert.ok(count > 0);
  });
});

describe('clearAllEmbeddings', () => {
  let store: SqliteStore;

  before(() => {
    store = SqliteStore.open();
  });

  after(() => {
    store.close();
  });

  it('clears all embeddings and returns count deleted', async () => {
    const embedder = new MockEmbedder(64);
    const v1 = await embedder.embed('text one');
    const v2 = await embedder.embed('text two');
    const v3 = await embedder.embed('text three');
    store.putEmbedding('clear-1', 'node', 'text one', v1, 'mock');
    store.putEmbedding('clear-2', 'node', 'text two', v2, 'mock');
    store.putEmbedding('clear-3', 'episode', 'text three', v3, 'mock');

    const deleted = store.clearAllEmbeddings();
    assert.equal(deleted, 3);
    assert.equal(store.embeddingCount(), 0);
  });
});

describe('embeddingCountByType', () => {
  let store: SqliteStore;

  before(async () => {
    store = SqliteStore.open();
    const embedder = new MockEmbedder(64);
    const v1 = await embedder.embed('node one');
    const v2 = await embedder.embed('node two');
    const v3 = await embedder.embed('episode one');
    store.putEmbedding('bytype-n1', 'node', 'node one', v1, 'mock');
    store.putEmbedding('bytype-n2', 'node', 'node two', v2, 'mock');
    store.putEmbedding('bytype-e1', 'episode', 'episode one', v3, 'mock');
  });

  after(() => {
    store.close();
  });

  it('returns correct count for node type', () => {
    assert.equal(store.embeddingCountByType('node'), 2);
  });

  it('returns correct count for episode type', () => {
    assert.equal(store.embeddingCountByType('episode'), 1);
  });
});

describe('OnnxEmbedder', () => {
  it('embed() returns Float32Array of 384 dimensions', async () => {
    const mockFactory = async (_modelId: string, _cacheDir: string) => {
      return (text: string, opts: { pooling: string; normalize: boolean }) => ({
        data: new Float32Array(384).fill(0.1),
      });
    };
    const embedder = new OnnxEmbedder({ _pipelineFactory: mockFactory });
    const result = await embedder.embed('hello world');
    assert.equal(result.length, 384);
    assert.ok(result instanceof Float32Array);
  });

  it('embedBatch() returns one vector per input', async () => {
    const mockFactory = async (_modelId: string, _cacheDir: string) => {
      return (text: string, opts: { pooling: string; normalize: boolean }) => ({
        data: new Float32Array(384).fill(0.1),
      });
    };
    const embedder = new OnnxEmbedder({ _pipelineFactory: mockFactory });
    const results = await embedder.embedBatch(['a', 'b', 'c']);
    assert.equal(results.length, 3);
    for (const vec of results) {
      assert.equal(vec.length, 384);
    }
  });

  it('name property is correct', () => {
    const embedder = new OnnxEmbedder({
      _pipelineFactory: async () => () => ({ data: new Float32Array(384) }),
    });
    assert.equal(embedder.name, 'onnx/all-MiniLM-L6-v2');
  });

  it('dimensions property is 384', () => {
    const embedder = new OnnxEmbedder({
      _pipelineFactory: async () => () => ({ data: new Float32Array(384) }),
    });
    assert.equal(embedder.dimensions, 384);
  });

  it('lazy initialization — pipeline not created until first embed()', async () => {
    let factoryCalled = 0;
    const mockFactory = async (_modelId: string, _cacheDir: string) => {
      factoryCalled++;
      return (text: string, opts: { pooling: string; normalize: boolean }) => ({
        data: new Float32Array(384).fill(0.1),
      });
    };
    const embedder = new OnnxEmbedder({ _pipelineFactory: mockFactory });

    assert.equal(factoryCalled, 0, 'factory should not be called at construction');

    await embedder.embed('test');
    assert.equal(factoryCalled, 1, 'factory should be called once after first embed');

    // Second embed should not call factory again
    await embedder.embed('test2');
    assert.equal(factoryCalled, 1, 'factory should still be called only once');
  });

  it('throws helpful error when module not found', async () => {
    const embedder = new OnnxEmbedder();
    await assert.rejects(
      () => embedder.embed('test'),
      (err: Error) => {
        assert.match(err.message, /requires @huggingface\/transformers/);
        return true;
      }
    );
  });
});

describe('OpenAIEmbedder', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('embed() returns Float32Array of 1536 dimensions', async () => {
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: Array(1536).fill(0.1), index: 0 }],
        }),
      } as Response;
    };

    const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
    const result = await embedder.embed('hello');
    assert.equal(result.length, 1536);
    assert.ok(result instanceof Float32Array);
  });

  it('embedBatch() returns results sorted by index', async () => {
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        ok: true,
        json: async () => ({
          data: [
            { embedding: Array(1536).fill(0.2), index: 1 },
            { embedding: Array(1536).fill(0.1), index: 0 },
          ],
        }),
      } as Response;
    };

    const embedder = new OpenAIEmbedder({ apiKey: 'test-key' });
    const results = await embedder.embedBatch(['first', 'second']);
    assert.equal(results.length, 2);
    // index 0 → fill(0.1) should be first
    assert.ok(Math.abs(results[0][0] - 0.1) < 1e-6, `expected 0.1 but got ${results[0][0]}`);
    // index 1 → fill(0.2) should be second
    assert.ok(Math.abs(results[1][0] - 0.2) < 1e-6, `expected 0.2 but got ${results[1][0]}`);
  });

  it('constructor throws without API key', () => {
    const savedKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      assert.throws(
        () => new OpenAIEmbedder(),
        (err: Error) => {
          assert.match(err.message, /requires an API key/);
          return true;
        }
      );
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('uses custom baseUrl in fetch call', async () => {
    let calledUrl = '';
    global.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
      calledUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: Array(1536).fill(0.1), index: 0 }],
        }),
      } as Response;
    };

    const embedder = new OpenAIEmbedder({ apiKey: 'k', baseUrl: 'https://custom.api/v1' });
    await embedder.embed('test');
    assert.ok(calledUrl.startsWith('https://custom.api/v1'), `URL was ${calledUrl}`);
  });

  it('401 response throws invalid key error', async () => {
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response;
    };

    const embedder = new OpenAIEmbedder({ apiKey: 'bad-key' });
    await assert.rejects(
      () => embedder.embed('test'),
      (err: Error) => {
        assert.match(err.message, /invalid/i);
        return true;
      }
    );
  });

  it('429 response throws rate limit error', async () => {
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      } as Response;
    };

    const embedder = new OpenAIEmbedder({ apiKey: 'some-key' });
    await assert.rejects(
      () => embedder.embed('test'),
      (err: Error) => {
        assert.match(err.message, /rate limit/i);
        return true;
      }
    );
  });

  it('text-embedding-3-large has 3072 dimensions', () => {
    const embedder = new OpenAIEmbedder({ apiKey: 'k', model: 'text-embedding-3-large' });
    assert.equal(embedder.dimensions, 3072);
  });

  it('name property includes model name', () => {
    const embedder = new OpenAIEmbedder({ apiKey: 'k' });
    assert.equal(embedder.name, 'openai/text-embedding-3-small');
  });
});
