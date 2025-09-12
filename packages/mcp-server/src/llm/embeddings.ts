import type { Embedder } from '../retrieval/interfaces.js';

export interface EmbedOptions {
  baseUrl?: string; // default from env LLM_BASE_URL
  model?: string; // default from env LLM_EMBED_MODEL
  timeoutMs?: number; // default 15000
}

export interface EmbeddingProviderConfig {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  normalize?: boolean; // Enable vector normalization for unit-length vectors
  dimensions?: number; // Override auto-detected dimensions
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

/**
 * Core embedding function with retry logic and error handling.
 * Works with any OpenAI-compatible endpoint.
 */
export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {return [];}
  
  const baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = opts.model || process.env.LLM_EMBED_MODEL || 'text-embedding-embeddinggemma-300m-qat';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || 15000);
  const maxRetries = Math.max(0, Number(process.env.EMBED_MAX_RETRIES || 3));
  const baseDelay = Math.max(0, Number(process.env.EMBED_BACKOFF_BASE_MS || 250));
  
  console.log(`Attempting embeddings with model: ${model}`);
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (isRetryable && attempt < maxRetries) {
          const ra = res.headers.get('retry-after');
          const raMs = ra ? (Number(ra) * 1000 || 0) : 0;
          const delay = Math.max(raMs, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 100);
          console.warn(`Embeddings retry ${attempt + 1}/${maxRetries} after HTTP ${res.status}. Waiting ${delay}ms`);
          attempt++;
          await sleep(delay);
          continue;
        }
        throw new Error(`embeddings HTTP ${res.status}: ${text}`);
      }
      const data = (await res.json()) as any;
      const vecs: number[][] = data?.data?.map((d: any) => d?.embedding).filter(Array.isArray) || [];
      return vecs;
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Normalize vectors to unit length for stable cosine similarity across models
 */
function normalizeVectors(vectors: number[][]): number[][] {
  return vectors.map(vec => {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {norm += vec[i] * vec[i];}
    norm = Math.sqrt(norm);
    if (!isFinite(norm) || norm === 0) {return vec;}
    const out = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) {out[i] = vec[i] / norm;}
    return out;
  });
}

/**
 * Universal embedding provider that works with any OpenAI-compatible endpoint.
 * Supports normalization, configurable dimensions, and all advanced features.
 */
export class UniversalEmbedder implements Embedder {
  public readonly dimensions: number;
  
  constructor(private config: EmbeddingProviderConfig = {}) {
    // Use provided dimensions or sensible defaults based on common models
    this.dimensions = config.dimensions || 768;
  }

  async embed(batch: string[]): Promise<number[][]> {
    const embedOptions: EmbedOptions = {
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      timeoutMs: this.config.timeoutMs
    };

    const raw = await embed(batch, embedOptions);
    
    // Apply normalization if requested
    return this.config.normalize ? normalizeVectors(raw) : raw;
  }
}

/**
 * Backward compatibility alias - GoogleEmbedder is now just a UniversalEmbedder
 * with normalization enabled and 768 dimensions (common for many models).
 */
export class GoogleEmbedder extends UniversalEmbedder {
  constructor(config: EmbeddingProviderConfig = {}) {
    super({
      normalize: true,
      dimensions: 768,
      ...config
    });
  }
}

// Legacy interface compatibility
export interface GoogleEmbedderConfig extends EmbeddingProviderConfig {}