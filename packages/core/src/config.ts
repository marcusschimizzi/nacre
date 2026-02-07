import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OnnxEmbedder, OllamaEmbedder, OpenAIEmbedder, MockEmbedder } from './embeddings.js';
import type { EmbeddingProvider } from './embeddings.js';

export type ProviderName = 'onnx' | 'ollama' | 'openai' | 'mock';

export interface EmbeddingConfig {
  provider: ProviderName;
  options?: Record<string, unknown>;
}

export interface NacreConfig {
  embeddings?: EmbeddingConfig;
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
      'No embedding provider configured. Set via --provider flag, nacre.config.json, or NACRE_EMBEDDING_PROVIDER env var. Available: onnx, ollama, openai, mock'
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
        `Unknown embedding provider: "${providerName}". Available: onnx, ollama, openai, mock`
      );
  }
}
