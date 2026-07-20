import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OnnxEmbedder, OllamaEmbedder, OpenAIEmbedder, MockEmbedder } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';
import {
  resolveWriteScope,
  scopePolicy,
  type ScopePolicy,
  type ScopePolicyOverrides,
} from './scopes.js';

export type ProviderName = 'onnx' | 'ollama' | 'openai' | 'mock';

export interface EmbeddingConfig {
  provider: ProviderName;
  options?: Record<string, unknown>;
}

export interface SnapshotConfig {
  enabled: boolean;
  retention?: string;
  triggers?: Array<'consolidation' | 'manual' | 'scheduled'>;
}

export interface MemoryDirConfig {
  /** Canonical memory directory (truth layer), absolute or relative to the graph's directory. */
  dir?: string;
  /** Scope for writes that don't specify one. Must be durable; default 'agent'. */
  defaultScope?: string;
}

export interface NacreConfig {
  embeddings?: EmbeddingConfig;
  snapshots?: SnapshotConfig;
  memory?: MemoryDirConfig;
  /** Per-scope policy overrides, keyed by exact scope or class (see scopes.ts). */
  scopes?: ScopePolicyOverrides;
}

export interface ResolveProviderOptions {
  provider?: string;
  graphPath?: string;
  apiKey?: string;
  baseUrl?: string;
  allowNull?: boolean;
}

export function loadConfig(graphPath: string | null): NacreConfig {
  if (!graphPath || graphPath === ':memory:') return {};

  const searchDirs = [dirname(graphPath), process.cwd()];
  for (const dir of searchDirs) {
    const configPath = join(dir, 'nacre.config.json');
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        return JSON.parse(raw) as NacreConfig;
      } catch {
        return {};
      }
    }
  }
  return {};
}

/**
 * Locate the canonical memory directory (truth layer) for a graph:
 * `memory.dir` from nacre.config.json (relative paths resolve against the
 * graph's directory), then NACRE_MEMORY_DIR, then a `memory/` directory next
 * to the graph if one exists. Null → capture/promotion are disabled.
 */
export function resolveMemoryDir(graphPath: string | null): string | null {
  const base = graphPath && graphPath !== ':memory:' ? dirname(graphPath) : process.cwd();

  const configured = loadConfig(graphPath).memory?.dir ?? process.env.NACRE_MEMORY_DIR;
  if (configured) {
    return configured.startsWith('/') ? configured : join(base, configured);
  }

  const conventional = join(base, 'memory');
  return existsSync(conventional) ? conventional : null;
}

/**
 * The scope a write to this graph lands in: explicit argument →
 * memory.defaultScope from nacre.config.json → 'agent'. Callers surface the
 * result in their responses so the default is always visible, never silent.
 */
export function resolveScopeForWrite(graphPath: string | null, explicit?: string): string {
  return resolveWriteScope(explicit, loadConfig(graphPath).memory?.defaultScope);
}

/** Effective policy for a scope on this graph (built-ins + config overrides). */
export function resolveScopePolicy(graphPath: string | null, scope: string): ScopePolicy {
  return scopePolicy(scope, loadConfig(graphPath).scopes);
}

export function resolveProvider(opts?: ResolveProviderOptions): EmbeddingProvider | null {
  let providerName: string | undefined = opts?.provider;

  if (!providerName) {
    const config = loadConfig(opts?.graphPath ?? null);
    providerName = config.embeddings?.provider;
  }

  if (!providerName) {
    providerName = process.env.NACRE_EMBEDDING_PROVIDER;
  }

  if (!providerName) {
    if (opts?.allowNull) return null;
    throw new Error(
      'No embedding provider configured. Set via --provider flag, nacre.config.json, or NACRE_EMBEDDING_PROVIDER env var. Available: onnx, ollama, openai, mock',
    );
  }

  switch (providerName) {
    case 'onnx':
      return new OnnxEmbedder();
    case 'ollama':
      return new OllamaEmbedder({
        baseUrl: opts?.baseUrl ?? process.env.NACRE_OLLAMA_URL,
      });
    case 'openai':
      return new OpenAIEmbedder({
        apiKey: opts?.apiKey ?? process.env.OPENAI_API_KEY,
        baseUrl: opts?.baseUrl,
      });
    case 'mock':
      return new MockEmbedder();
    default:
      throw new Error(
        `Unknown embedding provider: "${providerName}". Available: onnx, ollama, openai, mock`,
      );
  }
}
