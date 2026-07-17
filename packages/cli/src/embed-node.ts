import { encoderFingerprint } from '@nacre/core';
import type { EmbeddingProvider, MemoryNode, SqliteStore } from '@nacre/core';

/** Text embedded for a node — matches the `nacre embed` / consolidation format so a
 * later batch embed treats it as unchanged. */
export function nodeEmbeddingText(node: MemoryNode): string {
  return `${node.label} — ${node.excerpts.map((e) => e.text).join('. ')}`;
}

/**
 * Embed a freshly-created node into the store so it's immediately recallable by
 * semantic search. Best-effort:
 *  - no provider configured → no-op (graph-only recall still works);
 *  - an embedding error → no-op (non-fatal);
 *  - the graph's embeddings already belong to a different provider → no-op (we
 *    never silently mix providers or clear the existing index).
 *
 * On the first embedding it bootstraps the embedding_provider/embedding_dimensions
 * meta that recall's dimension guard reads. Returns whether the node was embedded.
 */
export async function embedNodeBestEffort(
  store: SqliteStore,
  provider: EmbeddingProvider | null,
  node: MemoryNode,
): Promise<boolean> {
  if (!provider) return false;

  // Never mix embedding spaces: skip if the store is pinned to a different
  // encoder fingerprint, or configured for a different provider, rather than
  // clear or corrupt the index.
  const storedFingerprint = store.getEncoderFingerprint();
  if (storedFingerprint && storedFingerprint !== encoderFingerprint(provider)) return false;

  const storedProvider = store.getMeta('embedding_provider');
  if (storedProvider && storedProvider !== provider.name) return false;

  try {
    const text = nodeEmbeddingText(node);
    const vector = await provider.embed(text);
    store.putEmbedding(node.id, 'node', text, vector, provider.name);
    if (!storedProvider) {
      store.setMeta('embedding_provider', provider.name);
      store.setMeta('embedding_dimensions', String(provider.dimensions));
    }
    return true;
  } catch {
    return false;
  }
}
