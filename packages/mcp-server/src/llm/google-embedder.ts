import { embed, type EmbedOptions } from './embeddings.js';
import type { Embedder } from '../retrieval/interfaces.js';

export interface GoogleEmbedderConfig {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export class GoogleEmbedder implements Embedder {
  public readonly dimensions = 768; // Google's embedding model dimensions
  
  constructor(private config: GoogleEmbedderConfig = {}) {}

  async embed(batch: string[]): Promise<number[][]> {
    const embedOptions: EmbedOptions = {
      baseUrl: this.config.baseUrl,
      model: this.config.model,
      timeoutMs: this.config.timeoutMs
    };

    const raw = await embed(batch, embedOptions);
    // Normalize to unit length for stable cosine similarity across models
    return raw.map(vec => {
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (!isFinite(norm) || norm === 0) return vec;
      const out = new Array(vec.length);
      for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
      return out;
    });
  }
}
