import type { Chunk } from '@app/shared';
import type { Embedder } from './interfaces.js';
import type { EnhancedEmbedding, EnhancedEmbedder, HybridSimilarityCalculator } from '../llm/enhanced-embedder.js';
import { embed as baseEmbed } from '../llm/embeddings.js';

export interface RetrievalConfig {
  // Two-stage retrieval
  enableTwoStageRetrieval: boolean;
  initialK: number; // First stage candidates
  finalK: number; // Final results after reranking
  
  // HyDE (Hypothetical Document Embeddings)
  enableHyDE: boolean;
  hydePrompt?: string;
  
  // Query expansion
  enableQueryExpansion: boolean;
  maxQueryVariants: number;
  expansionWeight: number; // 0.0-1.0
  
  // Contextual compression
  enableContextualCompression: boolean;
  compressionThreshold: number; // Similarity threshold for relevant sentences
  
  // MMR (Maximal Marginal Relevance)
  enableMMR: boolean;
  mmrLambda: number; // 0.0 = max diversity, 1.0 = max relevance
  
  // Reranking
  enableCrossEncoderRerank: boolean;
  rerankModel?: string;
  
  // Temporal scoring
  enableTemporalScoring: boolean;
  temporalWeight: number; // Weight for recency in scoring
  
  // Metadata filtering
  enableMetadataFiltering: boolean;
  metadataBoosts?: Record<string, number>;
}

export interface RetrievalResult {
  chunks: Chunk[];
  scores: number[];
  metadata: {
    originalQuery: string;
    expandedQueries?: string[];
    hydeDocument?: string;
    retrievalStage: 'initial' | 'reranked' | 'compressed';
    processingTime: number;
  };
}

export class EnhancedRetriever {
  constructor(
    private config: RetrievalConfig,
    private embedder: EnhancedEmbedder,
    private vectorStore: any, // Will be typed properly when we implement vector store optimizations
    private similarityCalculator: HybridSimilarityCalculator,
    private llmClient?: any // For HyDE document generation
  ) {}

  async retrieve(query: string, options?: {
    filters?: Record<string, any>;
    contextLength?: number;
    spaceId?: string;
  }): Promise<RetrievalResult> {
    const startTime = Date.now();
    let processedQuery = query;
    let expandedQueries: string[] = [];
    let hydeDocument: string | undefined;

    // Stage 1: Query Enhancement
    if (this.config.enableHyDE && this.llmClient) {
      hydeDocument = await this.generateHydeDocument(query);
      processedQuery = hydeDocument;
    }

    if (this.config.enableQueryExpansion) {
      expandedQueries = await this.expandQuery(query);
    }

    // Stage 2: Initial Retrieval
    const queryEmbedding = await this.embedder.embedEnhanced([processedQuery]);
    const initialCandidates = await this.performInitialRetrieval(
      queryEmbedding[0], 
      expandedQueries,
      options
    );

    // Stage 3: Reranking and Filtering
    let finalResults = initialCandidates;
    
    if (this.config.enableTwoStageRetrieval) {
      finalResults = await this.performSecondStageRetrieval(
        query, 
        queryEmbedding[0], 
        initialCandidates
      );
    }

    if (this.config.enableMMR) {
      finalResults = this.applyMMR(queryEmbedding[0], finalResults);
    }

    if (this.config.enableContextualCompression) {
      finalResults = await this.compressContext(query, finalResults);
    }

    // Extract final chunks and scores
    const chunks = finalResults.map(r => r.chunk);
    const scores = finalResults.map(r => r.score);

    return {
      chunks,
      scores,
      metadata: {
        originalQuery: query,
        expandedQueries: expandedQueries.length > 0 ? expandedQueries : undefined,
        hydeDocument,
        retrievalStage: this.config.enableTwoStageRetrieval ? 'reranked' : 'initial',
        processingTime: Date.now() - startTime
      }
    };
  }

  private distanceToSimilarity(distance?: number): number {
    if (typeof distance !== 'number' || !isFinite(distance) || distance < 0) return 0;
    // Map distance to [0,1] similarity monotonically
    return 1 / (1 + distance);
  }

  private async generateHydeDocument(query: string): Promise<string> {
    if (!this.llmClient) return query;
    
    const prompt = this.config.hydePrompt || `
      Write a detailed, technical document that would contain the answer to this question: "${query}"
      
      Focus on providing concrete information, code examples, and specific details that would be found in documentation or technical guides. Do not mention that this is hypothetical - write as if this is real documentation.
    `;

    try {
      const response = await this.llmClient.generate(prompt, {
        maxTokens: 300,
        temperature: 0.7
      });
      return response.text || query;
    } catch (error) {
      console.warn('HyDE generation failed:', error);
      return query;
    }
  }

  private async expandQuery(query: string): Promise<string[]> {
    const variants: string[] = [query];
    
    // Semantic variations
    variants.push(`How to ${query.toLowerCase()}`);
    variants.push(`What is ${query.toLowerCase()}`);
    variants.push(`${query} tutorial`);
    variants.push(`${query} documentation`);
    variants.push(`${query} example`);
    
    // Technical variations
    if (query.includes(' ')) {
      const words = query.split(' ');
      // Synonym replacement (simplified)
      variants.push(words.map(word => this.getSynonym(word)).join(' '));
      // Reordered terms
      variants.push(words.reverse().join(' '));
    }

    return variants.slice(0, this.config.maxQueryVariants);
  }

  private getSynonym(word: string): string {
    const synonyms: Record<string, string> = {
      'create': 'build',
      'build': 'create',
      'make': 'create',
      'setup': 'configure',
      'configure': 'setup',
      'install': 'setup',
      'use': 'implement',
      'implement': 'use',
      'fix': 'resolve',
      'resolve': 'fix',
      'error': 'issue',
      'issue': 'problem',
      'problem': 'issue'
    };
    
    return synonyms[word.toLowerCase()] || word;
  }

  private async performInitialRetrieval(
    queryEmbedding: EnhancedEmbedding,
    expandedQueries: string[],
    options?: any
  ): Promise<Array<{chunk: Chunk; score: number}>> {
    let allCandidates: Array<{chunk: Chunk; score: number}> = [];

    // Primary query retrieval
    const primaryResults = await this.vectorStore.search(
      queryEmbedding,
      {
        k: this.config.initialK,
        filters: options?.filters,
        spaceId: options?.spaceId,
        hybridSearch: true,
        adaptiveK: true,
      }
    );
    
    for (const result of primaryResults) {
      let score = this.similarityCalculator.calculateSimilarity(
        queryEmbedding,
        result.embedding
      );
      if (score <= 0 && typeof result.distance === 'number') {
        // Fallback to vector-store distance when document dense embedding isn't stored
        score = this.distanceToSimilarity(result.distance);
      }
      allCandidates.push({ chunk: result.chunk, score });
    }

    // Expanded queries retrieval
    if (expandedQueries.length > 0) {
      const expandedEmbeddings = await this.embedder.embedEnhanced(expandedQueries);
      
      for (const [idx, embedding] of expandedEmbeddings.entries()) {
        const expandedResults = await this.vectorStore.search(
          embedding,
          {
            k: Math.floor(this.config.initialK / 2),
            filters: options?.filters,
            spaceId: options?.spaceId,
            hybridSearch: true,
            adaptiveK: true,
          }
        );
        
        for (const result of expandedResults) {
          let baseScore = this.similarityCalculator.calculateSimilarity(
            embedding,
            result.embedding
          );
          if (baseScore <= 0 && typeof result.distance === 'number') {
            baseScore = this.distanceToSimilarity(result.distance);
          }
          const weightedScore = baseScore * this.config.expansionWeight;
          allCandidates.push({ chunk: result.chunk, score: weightedScore });
        }
      }
    }

    // Deduplicate and sort
    const uniqueCandidates = this.deduplicateResults(allCandidates)
      // drop extremely low-score noise
      .filter(c => c.score > 0.05);
    return uniqueCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.initialK);
  }

  private async performSecondStageRetrieval(
    originalQuery: string,
    queryEmbedding: EnhancedEmbedding,
    candidates: Array<{chunk: Chunk; score: number}>
  ): Promise<Array<{chunk: Chunk; score: number}>> {
    if (this.config.enableCrossEncoderRerank) {
      return await this.crossEncoderRerank(originalQuery, candidates);
    }

    // Fallback to enhanced similarity scoring
    return candidates.map(candidate => ({
      ...candidate,
      score: this.calculateEnhancedScore(queryEmbedding, candidate)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, this.config.finalK);
  }

  private async crossEncoderRerank(
    query: string,
    candidates: Array<{chunk: Chunk; score: number}>
  ): Promise<Array<{chunk: Chunk; score: number}>> {
    // Placeholder for cross-encoder reranking
    // In practice, this would use a cross-encoder model like ms-marco-MiniLM-L-12-v2
    console.log('Cross-encoder reranking not implemented yet, using enhanced scoring');
    
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.finalK);
  }

  private calculateEnhancedScore(
    queryEmbedding: EnhancedEmbedding,
    candidate: {chunk: Chunk; score: number}
  ): number {
    let enhancedScore = candidate.score;

    // Temporal scoring
    if (this.config.enableTemporalScoring && candidate.chunk.updatedAt) {
      const ageInDays = (Date.now() - new Date(candidate.chunk.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      const temporalScore = Math.exp(-ageInDays / 365); // Decay over a year
      enhancedScore += temporalScore * this.config.temporalWeight;
    }

    // Metadata boosts
    if (this.config.enableMetadataFiltering && this.config.metadataBoosts && candidate.chunk.metadata) {
      for (const [key, boost] of Object.entries(this.config.metadataBoosts)) {
        if (candidate.chunk.metadata[key]) {
          enhancedScore *= (1 + boost);
        }
      }
    }

    // Content quality indicators
    const textLength = candidate.chunk.text.length;
    const optimalLength = 500; // chars
    const lengthScore = 1 - Math.abs(textLength - optimalLength) / optimalLength;
    enhancedScore *= (1 + lengthScore * 0.1); // Small boost for optimal length

    return enhancedScore;
  }

  private applyMMR(
    queryEmbedding: EnhancedEmbedding,
    candidates: Array<{chunk: Chunk; score: number}>
  ): Array<{chunk: Chunk; score: number}> {
    const selected: Array<{chunk: Chunk; score: number}> = [];
    const remaining = [...candidates];

    while (selected.length < this.config.finalK && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        
        // Relevance score
        const relevanceScore = candidate.score;
        
        // Diversity score (minimum similarity to already selected)
        let minSimilarity = 1.0;
        if (selected.length > 0) {
          for (const selectedItem of selected) {
            const similarity = this.calculateTextSimilarity(
              candidate.chunk.text,
              selectedItem.chunk.text
            );
            minSimilarity = Math.min(minSimilarity, similarity);
          }
        }
        
        const diversityScore = 1 - minSimilarity;
        
        // MMR score
        const mmrScore = 
          this.config.mmrLambda * relevanceScore + 
          (1 - this.config.mmrLambda) * diversityScore;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected;
  }

  private async compressContext(
    query: string,
    candidates: Array<{chunk: Chunk; score: number}>
  ): Promise<Array<{chunk: Chunk; score: number}>> {
    const compressedCandidates: Array<{chunk: Chunk; score: number}> = [];

    for (const candidate of candidates) {
      const sentences = this.splitIntoSentences(candidate.chunk.text);
      const relevantSentences: string[] = [];

      // Simple sentence-level relevance scoring
      for (const sentence of sentences) {
        const sentenceEmbedding = await baseEmbed([sentence]);
        const queryWords = query.toLowerCase().split(/\s+/);
        const sentenceWords = sentence.toLowerCase().split(/\s+/);
        
        // Calculate overlap score
        const overlapScore = queryWords.filter(word => 
          sentenceWords.some(sentWord => sentWord.includes(word) || word.includes(sentWord))
        ).length / queryWords.length;

        if (overlapScore >= this.config.compressionThreshold) {
          relevantSentences.push(sentence);
        }
      }

      if (relevantSentences.length > 0) {
        const compressedChunk = {
          ...candidate.chunk,
          text: relevantSentences.join(' ')
        };
        compressedCandidates.push({
          ...candidate,
          chunk: compressedChunk
        });
      }
    }

    return compressedCandidates.length > 0 ? compressedCandidates : candidates;
  }

  private deduplicateResults(
    candidates: Array<{chunk: Chunk; score: number}>
  ): Array<{chunk: Chunk; score: number}> {
    const seen = new Set<string>();
    const unique: Array<{chunk: Chunk; score: number}> = [];

    for (const candidate of candidates) {
      const key = `${candidate.chunk.pageId}-${candidate.chunk.sectionAnchor || ''}-${candidate.chunk.text.slice(0, 100)}`;
      
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(candidate);
      } else {
        // If we've seen this chunk before, keep the one with higher score
        const existingIdx = unique.findIndex(u => {
          const existingKey = `${u.chunk.pageId}-${u.chunk.sectionAnchor || ''}-${u.chunk.text.slice(0, 100)}`;
          return existingKey === key;
        });
        
        if (existingIdx >= 0 && candidate.score > unique[existingIdx].score) {
          unique[existingIdx] = candidate;
        }
      }
    }

    return unique;
  }

  private calculateTextSimilarity(text1: string, text2: string): number {
    // Simple Jaccard similarity for diversity calculation
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(word => words2.has(word)));
    const union = new Set([...words1, ...words2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  private splitIntoSentences(text: string): string[] {
    return text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 10); // Filter out very short fragments
  }
}

// Query expansion utilities
export class QueryExpander {
  private synonyms: Record<string, string[]> = {
    'create': ['build', 'make', 'generate', 'construct'],
    'setup': ['configure', 'install', 'initialize', 'prepare'],
    'fix': ['resolve', 'repair', 'debug', 'correct'],
    'error': ['issue', 'problem', 'bug', 'exception'],
    'use': ['utilize', 'implement', 'apply', 'employ'],
    'delete': ['remove', 'destroy', 'eliminate', 'drop'],
    'update': ['modify', 'change', 'edit', 'revise'],
    'get': ['retrieve', 'fetch', 'obtain', 'access']
  };

  expandQuery(query: string, maxVariants: number = 5): string[] {
    const variants = [query];
    const words = query.toLowerCase().split(/\s+/);
    
    // Generate semantic variants
    for (const word of words) {
      const synonymList = this.synonyms[word];
      if (synonymList) {
        for (const synonym of synonymList.slice(0, 2)) {
          const variant = query.replace(new RegExp(word, 'gi'), synonym);
          if (!variants.includes(variant)) {
            variants.push(variant);
            if (variants.length >= maxVariants) break;
          }
        }
        if (variants.length >= maxVariants) break;
      }
    }
    
    // Add question variations
    if (!query.includes('?') && variants.length < maxVariants) {
      variants.push(`How to ${query.toLowerCase()}?`);
      variants.push(`What is ${query.toLowerCase()}?`);
    }
    
    return variants.slice(0, maxVariants);
  }
}
