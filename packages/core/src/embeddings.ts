// ── Interface ────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly name: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

// ── Cosine Similarity ────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ── Serialization Helpers ────────────────────────────────────────

/** Convert Float32Array to Buffer for SQLite BLOB storage. */
export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Convert Buffer (from SQLite BLOB) back to Float32Array. */
export function bufferToVector(buffer: Buffer): Float32Array {
  // Copy into a new ArrayBuffer to guarantee alignment
  const ab = new ArrayBuffer(buffer.byteLength);
  const view = new Uint8Array(ab);
  view.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  return new Float32Array(ab);
}

// ── Mock Provider (for testing) ──────────────────────────────────

/** Deterministic embedder for testing — produces consistent unit-normalized vectors from input hash. */
export class MockEmbedder implements EmbeddingProvider {
  readonly dimensions: number;
  readonly name = 'mock';

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.deterministicVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => this.deterministicVector(t));
  }

  private deterministicVector(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash << 13) ^ hash) | 0;
      hash = (hash * 0x5bd1e995) | 0;
      hash = (hash ^ (hash >> 15)) | 0;
      vec[i] = (hash & 0xffff) / 0x10000 - 0.5;
    }

    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}

// ── ONNX Provider (local, zero-service) ──────────────────────────

export interface OnnxEmbedderOptions {
  modelId?: string;
  cacheDir?: string;
}

/** Local embedding provider using @huggingface/transformers + ONNX Runtime. */
export class OnnxEmbedder implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly name = 'onnx/all-MiniLM-L6-v2';

  private pipeline: unknown = null;
  private readonly modelId: string;
  private readonly cacheDir: string;
  private readonly _pipelineFactory?: (modelId: string, cacheDir: string) => Promise<unknown>;

  constructor(opts?: OnnxEmbedderOptions & { _pipelineFactory?: (modelId: string, cacheDir: string) => Promise<unknown> }) {
    this.modelId = opts?.modelId ?? 'Xenova/all-MiniLM-L6-v2';
    this.cacheDir = opts?.cacheDir ?? OnnxEmbedder.defaultCacheDir();
    this._pipelineFactory = opts?._pipelineFactory;
  }

  private static defaultCacheDir(): string {
    try {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
      return `${home}/.nacre/models`;
    } catch {
      return '.nacre/models';
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.pipeline) return;

    if (this._pipelineFactory) {
      this.pipeline = await this._pipelineFactory(this.modelId, this.cacheDir);
      return;
    }

    try {
      // Dynamic import — module is an optional dependency
      const modName = '@huggingface/transformers';
      const mod = await (Function('m', 'return import(m)')(modName) as Promise<Record<string, unknown>>);
      const createPipeline = mod.pipeline as (task: string, model: string) => Promise<unknown>;
      const env = mod.env as { cacheDir: string };
      env.cacheDir = this.cacheDir;
      this.pipeline = await createPipeline('feature-extraction', this.modelId);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' ||
          (err instanceof Error && (err.message.includes('Cannot find') || err.message.includes('Failed to fetch')))) {
        throw new Error(
          'ONNX provider requires @huggingface/transformers. Install it with: npm install @huggingface/transformers'
        );
      }
      throw err;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    await this.ensureInitialized();
    const extractor = this.pipeline as (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await this.ensureInitialized();
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}

// ── Ollama Provider ──────────────────────────────────────────────

export interface OllamaEmbedderOptions {
  model?: string;
  baseUrl?: string;
}

/** Ollama embedding provider. Default model: nomic-embed-text (768 dims). */
export class OllamaEmbedder implements EmbeddingProvider {
  readonly dimensions: number;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts?: OllamaEmbedderOptions) {
    this.model = opts?.model ?? 'nomic-embed-text';
    this.baseUrl = (opts?.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.name = `ollama/${this.model}`;
    this.dimensions = 768;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return new Float32Array(data.embeddings[0]);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embedBatch failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings.map(e => new Float32Array(e));
  }
}
