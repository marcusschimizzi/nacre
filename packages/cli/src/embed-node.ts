import { encoderFingerprint } from '@nacre/core';
import type { EmbeddingProvider, MemoryNode, SqliteStore } from '@nacre/core';

/** Text embedded for a node — matches the `nacre embed` / consolidation format so a
 * later batch embed treats it as unchanged. */
export function nodeEmbeddingText(node: MemoryNode): string {
  return `${node.label} — ${node.excerpts.map((e) => e.text).join('. ')}`;
}

export interface EmbedNodeResult {
  embedded: boolean;
  /** Why the node was not embedded — callers must surface this so a write
   * never silently looks semantically searchable when it isn't. */
  reason?: 'no-provider' | 'encoder-mismatch' | 'provider-config' | 'error';
}

/**
 * Embed a freshly-created node into the store so it's immediately recallable
 * by semantic search. Best-effort — a failed embed never fails the write —
 * but never silent: the result says whether the node is searchable and why
 * not, so MCP/API responses can tell the client the truth.
 *
 *  - no provider configured → skipped (graph-only recall still works);
 *  - the store is pinned to a different encoder fingerprint, or configured
 *    for a different provider → skipped (we never mix embedding spaces or
 *    clear the existing index);
 *  - embedding call fails → skipped, non-fatal.
 *
 * On the first embedding it bootstraps the embedding_provider/embedding_dimensions
 * meta that recall's dimension guard reads.
 */
export async function embedNodeBestEffort(
  store: SqliteStore,
  provider: EmbeddingProvider | null,
  node: MemoryNode,
): Promise<EmbedNodeResult> {
  if (!provider) return { embedded: false, reason: 'no-provider' };

  const storedFingerprint = store.getEncoderFingerprint();
  if (storedFingerprint && storedFingerprint !== encoderFingerprint(provider)) {
    return { embedded: false, reason: 'encoder-mismatch' };
  }

  const storedProvider = store.getMeta('embedding_provider');
  if (storedProvider && storedProvider !== provider.name) {
    return { embedded: false, reason: 'provider-config' };
  }

  try {
    const text = nodeEmbeddingText(node);
    const vector = await provider.embed(text);
    store.putEmbedding(node.id, 'node', text, vector, provider.name);
    if (!storedProvider) {
      store.setMeta('embedding_provider', provider.name);
      store.setMeta('embedding_dimensions', String(provider.dimensions));
    }
    return { embedded: true };
  } catch {
    return { embedded: false, reason: 'error' };
  }
}

/** Human-readable warning for a not-embedded outcome, or empty when embedded. */
export function embedResultWarning(result: EmbedNodeResult): string {
  switch (result.reason) {
    case 'encoder-mismatch':
      return "⚠ Not semantically searchable: the store's vectors use a different encoder. Run 'nacre embed --rebuild' or fix the provider config.";
    case 'provider-config':
      return '⚠ Not semantically searchable: the store is configured for a different embedding provider.';
    case 'error':
      return '⚠ Not semantically searchable: the embedding call failed (provider unavailable?). Run `nacre embed` to backfill.';
    case 'no-provider':
    case undefined:
      return '';
  }
}
