import type { Embedder } from '../retrieval/interfaces.js';
import { embed as baseEmbed, type EmbedOptions } from './embeddings.js';

export interface EnhancedEmbeddingConfig {
  // Multi-level embedding settings
  enableDocumentLevelEmbedding: boolean;
  enableSectionLevelEmbedding: boolean; 
  enableChunkLevelEmbedding: boolean;
  
  // Context enhancement
  contextWindowSize: number; // Words to include around chunk
  includeHierarchicalContext: boolean; // Include parent section info
  
  // Hybrid embedding settings  
  enableSparseEmbeddings: boolean; // BM25-style keyword embeddings
  denseWeight: number; // 0.0-1.0 weight for dense embeddings
  sparseWeight: number; // 0.0-1.0 weight for sparse embeddings
  
  // Query-time augmentation
  enableQueryExpansion: boolean;
  maxQueryVariants: number;
  
  // Embedding enhancement
  enableTitleWeighting: boolean;
  titleWeight: number;
  enableMetadataEmbedding: boolean;
}

export interface EnhancedEmbedding {
  dense: number[]; // Standard dense embedding
  sparse?: Map<string, number>; // Sparse keyword weights
  document?: number[]; // Document-level embedding
  section?: number[]; // Section-level embedding
  metadata: {
    level: 'chunk' | 'section' | 'document';
    hasContext: boolean;
    tokenCount: number;
    keywords: string[];
  };
}

export class EnhancedEmbedder implements Embedder {
  public dimensions: number = 384; // Default dimension, should be configured based on model

  constructor(
    private config: EnhancedEmbeddingConfig,
    private baseEmbedder?: Embedder
  ) {
    // Use base embedder dimensions if available
    if (baseEmbedder?.dimensions) {
      this.dimensions = baseEmbedder.dimensions;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    // For backward compatibility, return dense embeddings
    const enhanced = await this.embedEnhanced(texts);
    return enhanced.map(e => e.dense);
  }

  async embedEnhanced(texts: string[], context?: {
    documentTitle?: string;
    sectionHeading?: string;
    metadata?: any;
    hierarchicalContext?: string[];
  }): Promise<EnhancedEmbedding[]> {
    const results: EnhancedEmbedding[] = [];
    
    for (const text of texts) {
      const enhanced = await this.embedSingleText(text, context);
      results.push(enhanced);
    }
    
    return results;
  }

  private async embedSingleText(
    text: string, 
    context?: {
      documentTitle?: string;
      sectionHeading?: string;
      metadata?: any;
      hierarchicalContext?: string[];
    }
  ): Promise<EnhancedEmbedding> {
    // Prepare enhanced text with context
    const enhancedText = this.prepareEnhancedText(text, context);
    
    // Generate dense embedding
    const denseEmbeddings = await baseEmbed([enhancedText.main]);
    const dense = denseEmbeddings[0] || [];
    
    // Generate multi-level embeddings if enabled
    const multiLevel = await this.generateMultiLevelEmbeddings(enhancedText, context);
    
    // Generate sparse embeddings if enabled
    const sparse = this.config.enableSparseEmbeddings 
      ? this.generateSparseEmbedding(enhancedText.main)
      : undefined;
    
    // Extract keywords
    const keywords = this.extractKeywords(text);
    
    return {
      dense,
      sparse,
      document: multiLevel.document,
      section: multiLevel.section,
      metadata: {
        level: 'chunk',
        hasContext: enhancedText.hasContext,
        tokenCount: this.estimateTokens(text),
        keywords
      }
    };
  }

  private prepareEnhancedText(
    text: string,
    context?: {
      documentTitle?: string;
      sectionHeading?: string;
      metadata?: any;
      hierarchicalContext?: string[];
    }
  ): { main: string; hasContext: boolean; variants: string[] } {
    const parts: string[] = [];
    let hasContext = false;
    
    // Add hierarchical context if enabled
    if (this.config.includeHierarchicalContext && context?.hierarchicalContext) {
      parts.push(...context.hierarchicalContext);
      hasContext = true;
    }
    
    // Add title with weighting if enabled
    if (this.config.enableTitleWeighting && context?.documentTitle) {
      const titleRepeats = Array(this.config.titleWeight).fill(context.documentTitle);
      parts.push(...titleRepeats);
      hasContext = true;
    }
    
    // Add section heading
    if (context?.sectionHeading) {
      parts.push(`Section: ${context.sectionHeading}`);
      hasContext = true;
    }
    
    // Add metadata if enabled
    if (this.config.enableMetadataEmbedding && context?.metadata) {
      const metadataText = this.formatMetadata(context.metadata);
      if (metadataText) {
        parts.push(metadataText);
        hasContext = true;
      }
    }
    
    // Add main text
    parts.push(text);
    
    const main = parts.join('\n\n');
    
    // Generate variants for query expansion
    const variants = this.config.enableQueryExpansion 
      ? this.generateTextVariants(text, context)
      : [main];
    
    return { main, hasContext, variants };
  }

  private async generateMultiLevelEmbeddings(
    enhancedText: { main: string; hasContext: boolean; variants: string[] },
    context?: any
  ): Promise<{ document?: number[]; section?: number[] }> {
    const result: { document?: number[]; section?: number[] } = {};
    
    // Document-level embedding (if we have document context)
    if (this.config.enableDocumentLevelEmbedding && context?.documentTitle) {
      const docText = `${context.documentTitle}\n\n${enhancedText.main}`;
      const docEmbeddings = await baseEmbed([docText]);
      result.document = docEmbeddings[0];
    }
    
    // Section-level embedding (if we have section context)
    if (this.config.enableSectionLevelEmbedding && context?.sectionHeading) {
      const sectionText = `${context.sectionHeading}\n\n${enhancedText.main}`;
      const sectionEmbeddings = await baseEmbed([sectionText]);
      result.section = sectionEmbeddings[0];
    }
    
    return result;
  }

  private generateSparseEmbedding(text: string): Map<string, number> {
    // Generate BM25-style sparse embeddings
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2);
    
    // Calculate term frequencies
    const tf = new Map<string, number>();
    for (const word of words) {
      tf.set(word, (tf.get(word) || 0) + 1);
    }
    
    // Normalize by document length and apply TF-IDF-like weighting
    const docLength = words.length;
    const sparse = new Map<string, number>();
    
    for (const [term, freq] of tf) {
      // Simple TF-IDF approximation
      const tfScore = freq / docLength;
      const idfScore = Math.log(1000 / (freq + 1)); // Assume corpus size of 1000
      const score = tfScore * idfScore;
      
      if (score > 0.01) { // Filter low-scoring terms
        sparse.set(term, score);
      }
    }
    
    return sparse;
  }

  private generateTextVariants(text: string, context?: any): string[] {
    // Generate query expansion variants
    const variants = [text];
    
    // Add question variants
    if (!text.includes('?')) {
      variants.push(`How to ${text.toLowerCase()}?`);
      variants.push(`What is ${text.toLowerCase()}?`);
    }
    
    // Add context-specific variants
    if (context?.sectionHeading) {
      variants.push(`${context.sectionHeading}: ${text}`);
    }
    
    return variants.slice(0, this.config.maxQueryVariants);
  }

  private formatMetadata(metadata: any): string {
    const parts: string[] = [];
    
    if (metadata.hasCode) {parts.push('Contains code examples');}
    if (metadata.hasTables) {parts.push('Contains data tables');}
    if (metadata.hasLists) {parts.push('Contains structured lists');}
    if (metadata.hasImages) {parts.push('Contains images or diagrams');}
    
    return parts.length > 0 ? `Document features: ${parts.join(', ')}` : '';
  }

  private extractKeywords(text: string): string[] {
    // Extract important keywords using simple heuristics
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 3);
    
    // Count word frequencies
    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }
    
    // Return top keywords
    return Array.from(freq.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([word]) => word);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }
}

// Hybrid similarity calculation for retrieval
export class HybridSimilarityCalculator {
  constructor(
    private denseWeight: number = 0.7,
    private sparseWeight: number = 0.3
  ) {}

  calculateSimilarity(
    queryEmbedding: EnhancedEmbedding,
    documentEmbedding: EnhancedEmbedding
  ): number {
    let totalScore = 0;
    let weightSum = 0;

    // Dense similarity (cosine)
    if (queryEmbedding.dense && documentEmbedding.dense) {
      const denseScore = this.cosineSimilarity(queryEmbedding.dense, documentEmbedding.dense);
      totalScore += denseScore * this.denseWeight;
      weightSum += this.denseWeight;
    }

    // Sparse similarity (overlap)
    if (queryEmbedding.sparse && documentEmbedding.sparse) {
      const sparseScore = this.sparseSimilarity(queryEmbedding.sparse, documentEmbedding.sparse);
      totalScore += sparseScore * this.sparseWeight;
      weightSum += this.sparseWeight;
    }

    return weightSum > 0 ? totalScore / weightSum : 0;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {return 0;}

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {return 0;}
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private sparseSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let overlap = 0;
    let totalA = 0;
    let totalB = 0;

    // Calculate overlap
    for (const [term, scoreA] of a) {
      totalA += scoreA;
      if (b.has(term)) {
        overlap += Math.min(scoreA, b.get(term)!);
      }
    }

    for (const scoreB of b.values()) {
      totalB += scoreB;
    }

    const union = totalA + totalB - overlap;
    return union > 0 ? overlap / union : 0;
  }
}