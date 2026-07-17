import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../store.js';
import {
  MockEmbedder,
  EncoderMismatchError,
  encoderFingerprint,
  makeFingerprint,
  fingerprintDimensions,
} from '../embeddings.js';

function vec(dims: number, fill = 0.5): Float32Array {
  return new Float32Array(dims).fill(fill);
}

describe('encoder fingerprint helpers', () => {
  it('builds and parses fingerprints', () => {
    assert.equal(makeFingerprint('onnx/all-MiniLM-L6-v2', 384), 'onnx/all-MiniLM-L6-v2:384');
    assert.equal(fingerprintDimensions('onnx/all-MiniLM-L6-v2:384'), 384);
  });

  it('parses dimensions when the provider name itself contains colons', () => {
    // e.g. ollama model tags: ollama/nomic-embed-text:v1.5
    const fp = makeFingerprint('ollama/nomic-embed-text:v1.5', 768);
    assert.equal(fingerprintDimensions(fp), 768);
  });

  it('derives a fingerprint from a provider instance', () => {
    const provider = new MockEmbedder(64);
    assert.equal(encoderFingerprint(provider), 'mock:64');
  });
});

describe('encoder pinning in SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = SqliteStore.open(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('has no fingerprint before any embedding is written', () => {
    assert.equal(store.getEncoderFingerprint(), undefined);
  });

  it('stamps the fingerprint on the first embedding write', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    assert.equal(store.getEncoderFingerprint(), 'mock:64');
  });

  it('rejects a write from a different provider name', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    assert.throws(
      () => store.putEmbedding('n2', 'node', 'text', vec(64), 'ollama/nomic-embed-text'),
      EncoderMismatchError,
    );
  });

  it('rejects a write with the same provider name but different dimensions', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    assert.throws(() => store.putEmbedding('n2', 'node', 'text', vec(128), 'mock'), EncoderMismatchError);
  });

  it('accepts subsequent writes from the same encoder', () => {
    store.putEmbedding('n1', 'node', 'text one', vec(64, 0.1), 'mock');
    store.putEmbedding('n2', 'node', 'text two', vec(64, 0.9), 'mock');
    assert.equal(store.embeddingCount(), 2);
  });

  it('searchSimilar hard-fails on a query vector from a different space', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    assert.throws(() => store.searchSimilar(vec(384)), EncoderMismatchError);
  });

  it('searchSimilar works with a matching query vector', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    const results = store.searchSimilar(vec(64));
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'n1');
  });

  it('the mismatch error carries remediation guidance', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    try {
      store.searchSimilar(vec(384));
      assert.fail('expected EncoderMismatchError');
    } catch (err) {
      assert.ok(err instanceof EncoderMismatchError);
      assert.match(err.message, /nacre embed .*--rebuild/);
      assert.equal(err.stored, 'mock:64');
    }
  });

  it('clearAllEmbeddings resets the fingerprint so a new encoder can stamp', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    store.clearAllEmbeddings();
    assert.equal(store.getEncoderFingerprint(), undefined);
    store.putEmbedding('n1', 'node', 'text', vec(384), 'onnx/all-MiniLM-L6-v2');
    assert.equal(store.getEncoderFingerprint(), 'onnx/all-MiniLM-L6-v2:384');
  });

  it('backfills the fingerprint for legacy stores with embeddings but no stamp', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    // Simulate a store created before pinning: embeddings exist, no meta stamp.
    (store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare("DELETE FROM meta WHERE key = 'encoder_fingerprint'")
      .run();
    assert.equal(store.getEncoderFingerprint(), 'mock:64');
    // And the derived stamp now enforces like a normal one.
    assert.throws(() => store.searchSimilar(vec(384)), EncoderMismatchError);
  });

  it('putEmbeddingsBatch enforces the fingerprint transactionally', () => {
    store.putEmbedding('n1', 'node', 'text', vec(64), 'mock');
    assert.throws(() =>
      store.putEmbeddingsBatch([
        { id: 'n2', type: 'node', content: 'a', vector: vec(64), provider: 'mock' },
        { id: 'n3', type: 'node', content: 'b', vector: vec(768), provider: 'ollama/nomic-embed-text' },
      ]),
    );
    // The failing batch must not have partially applied.
    assert.equal(store.embeddingCount(), 1);
  });
});
