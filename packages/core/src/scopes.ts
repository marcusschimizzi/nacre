// ── Scope model (V2-2) ───────────────────────────────────────────
//
// The single authority for "whose memory is this and where may it go".
// Scopes separate CONTEXTS for a single user, not principals:
//
//   user               durable, follows the human across everything
//   project/<name>     durable, bound to a project context
//   agent              durable, local-operational to this agent
//   session            scratch — never file-backed, never syncs, expires
//
// Durable scopes participate in the truth layer (spool → canonical file →
// compile). Session scratch lives only in the store and is purged by
// consolidation after its retention window. See docs/V2-2-SCOPE-MODEL.md.

export const SESSION_SCOPE = 'session';

const PROJECT_SCOPE_RE = /^project\/[a-z0-9][a-z0-9._-]*$/;

/** Durable scopes — the only scopes canonical files may carry. */
export function isValidScope(scope: string): boolean {
  return scope === 'user' || scope === 'agent' || PROJECT_SCOPE_RE.test(scope);
}

/** Alias with the V2-2 vocabulary: durable = truth-layer-backed. */
export const isDurableScope = isValidScope;

/** Durable scopes plus session scratch. */
export function isKnownScope(scope: string): boolean {
  return scope === SESSION_SCOPE || isDurableScope(scope);
}

export type ScopeClass = 'user' | 'agent' | 'project' | 'session';

/** The policy class a scope belongs to ('project' covers every project/<name>). */
export function scopeClass(scope: string): ScopeClass | undefined {
  if (scope === 'user' || scope === 'agent' || scope === SESSION_SCOPE) return scope;
  if (PROJECT_SCOPE_RE.test(scope)) return 'project';
  return undefined;
}

/** Directory (relative to the memory root) where a durable scope's memories live. */
export function scopeToDir(scope: string): string {
  if (!isDurableScope(scope)) throw new Error(`Invalid durable scope: "${scope}"`);
  if (scope.startsWith('project/')) return `projects/${scope.slice('project/'.length)}`;
  return scope;
}

/**
 * Scope encoded by a memory file's path relative to the memory root, e.g.
 * 'projects/nacre/decisions/x.md' → 'project/nacre'. Undefined for paths
 * outside the scope directories (e.g. '.capture/').
 */
export function pathToScope(relPath: string): string | undefined {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  if (parts[0] === 'user') return 'user';
  if (parts[0] === 'agent') return 'agent';
  if (parts[0] === 'projects' && parts.length >= 3) {
    const scope = `project/${parts[1]}`;
    return isDurableScope(scope) ? scope : undefined;
  }
  return undefined;
}

/**
 * A copy of the graph containing only scope-visible nodes (and the edges
 * between them). Used by brief/insight surfaces that consume a whole graph.
 */
export function filterGraphByScopes<
  N extends { scope?: string; status?: string },
  E extends { source: string; target: string },
  G extends { nodes: Record<string, N>; edges: Record<string, E> },
>(graph: G, scopes?: string[]): G {
  const nodes: Record<string, N> = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    if (nodeVisibleInScopes(node, scopes)) nodes[id] = node;
  }
  const edges: Record<string, E> = {};
  for (const [id, edge] of Object.entries(graph.edges)) {
    if (nodes[edge.source] && nodes[edge.target]) edges[id] = edge;
  }
  return { ...graph, nodes, edges };
}

/**
 * Parse a user-supplied scopes filter (comma-separated string or array) into
 * the canonical form: trimmed, empties dropped, and an EMPTY result treated
 * as "no filter" — otherwise `scopes=,` or `[]` would silently exclude every
 * durable memory while still returning entities, indistinguishable from an
 * empty store.
 */
export function parseScopesFilter(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = (Array.isArray(raw) ? raw : raw.split(',')).map((x) => x.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// ── Per-scope policy ─────────────────────────────────────────────

export interface ScopePolicy {
  /** Whether writes in this scope enter the capture spool / truth layer. */
  spooled: boolean;
  /** Whether memories in this scope may enter federated hive graphs. */
  hiveEligible: boolean;
  /** V2-7 hook: whether this scope's files are meant to git-sync across devices. */
  syncEligible: boolean;
  /** Days until consolidation purges rows in this scope; null = never expires. */
  retentionDays: number | null;
}

export const DEFAULT_SCOPE_POLICIES: Record<ScopeClass, ScopePolicy> = {
  user: { spooled: true, hiveEligible: true, syncEligible: true, retentionDays: null },
  project: { spooled: true, hiveEligible: true, syncEligible: true, retentionDays: null },
  agent: { spooled: true, hiveEligible: false, syncEligible: false, retentionDays: null },
  session: { spooled: false, hiveEligible: false, syncEligible: false, retentionDays: 7 },
};

/**
 * Config overrides from nacre.config.json → `scopes`. Keys may be an exact
 * scope ('project/nacre', 'agent') or a class ('project' applies to every
 * project scope). Exact keys win over class keys.
 */
export type ScopePolicyOverrides = Record<string, Partial<ScopePolicy>>;

export function scopePolicy(scope: string, overrides?: ScopePolicyOverrides): ScopePolicy {
  const cls = scopeClass(scope);
  // Unknown scopes get the most conservative treatment: store-only scratch.
  if (!cls) return { ...DEFAULT_SCOPE_POLICIES.session };
  return {
    ...DEFAULT_SCOPE_POLICIES[cls],
    ...(overrides?.[cls] ?? {}),
    ...(scope !== cls ? (overrides?.[scope] ?? {}) : {}),
  };
}

// ── Read-side visibility (D2) ────────────────────────────────────

/**
 * The scope that governs a node's visibility. Entities (no scope, no
 * lifecycle status) return null — they are the shared vocabulary, visible
 * from every scope. Memory rows predating schema v9 (status but no scope)
 * are treated as 'agent'.
 */
export function effectiveNodeScope(node: { scope?: string; status?: string }): string | null {
  if (node.scope) return node.scope;
  return node.status ? 'agent' : null;
}

/**
 * Whether something with the given effective scope is visible under a scope
 * filter. `scopes === undefined` means the default read: every durable scope,
 * never session — session scratch must be requested explicitly.
 */
export function scopeVisible(effective: string | null, scopes?: string[]): boolean {
  if (effective === null) return true;
  // Session — and any unknown scope string, which scopePolicy already treats
  // as scratch-class — is hidden unless explicitly listed. Reading unknown
  // scopes as durable-forever while policy treats them as scratch was an
  // inconsistency: one rule now.
  if (effective === SESSION_SCOPE || !isDurableScope(effective)) {
    return scopes?.includes(effective) ?? false;
  }
  return scopes === undefined || scopes.includes(effective);
}

export function nodeVisibleInScopes(
  node: { scope?: string; status?: string },
  scopes?: string[],
): boolean {
  return scopeVisible(effectiveNodeScope(node), scopes);
}

/** Episodes/procedures: unset scope = pre-v9 legacy, treated as 'agent'. */
export function recordVisibleInScopes(record: { scope?: string }, scopes?: string[]): boolean {
  return scopeVisible(record.scope ?? 'agent', scopes);
}

/**
 * The scope a write lands in when the caller did not specify one:
 * explicit argument → configured default → 'agent'. The configured default
 * must be durable — a session default would silently make everything
 * scratch; callers surface the returned scope in their responses so the
 * default is always visible.
 */
export function resolveWriteScope(explicit?: string, configuredDefault?: string): string {
  if (explicit && isKnownScope(explicit)) return explicit;
  if (configuredDefault && isDurableScope(configuredDefault)) return configuredDefault;
  return 'agent';
}
