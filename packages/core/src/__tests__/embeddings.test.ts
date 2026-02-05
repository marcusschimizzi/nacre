import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import {
  MockEmbedder,
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
