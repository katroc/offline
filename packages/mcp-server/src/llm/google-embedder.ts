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

    return await embed(batch, embedOptions);
  }
}