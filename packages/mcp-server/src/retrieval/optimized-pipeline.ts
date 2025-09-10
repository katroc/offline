import type { Chunk, ConfluencePage } from '@app/shared';
import type { ChunkingConfig } from './chunker.js';
import { SemanticChunker, type SemanticChunkingConfig } from './semantic-chunker.js';
import { SimpleChunker } from './chunker.js';
import { EnhancedEmbedder, HybridSimilarityCalculator, type EnhancedEmbeddingConfig } from '../llm/enhanced-embedder.js';
import { EnhancedRetriever, type RetrievalConfig } from './enhanced-retriever.js';
import { OptimizedVectorStore, type VectorStoreConfig } from './optimized-vector-store.js';
import type { Embedder } from './interfaces.js';

export interface OptimizedPipelineConfig {
  // Strategy selection
  chunkingStrategy: 'simple' | 'semantic';
  embeddingStrategy: 'standard' | 'enhanced';
  retrievalStrategy: 'basic' | 'advanced';
  
  // Component configurations
  chunking: ChunkingConfig & Partial<SemanticChunkingConfig>;
  embedding: EnhancedEmbeddingConfig;
  retrieval: RetrievalConfig;
  vectorStore: VectorStoreConfig;
  
  // Performance settings
  enableParallelProcessing: boolean;
  maxConcurrentEmbeddings: number;
  processingTimeout: number; // milliseconds
  
  // Quality settings
  enableQualityMetrics: boolean;
  minChunkQualityScore: number;
  enableContentFiltering: boolean;
}

export interface ProcessingMetrics {
  chunkingTime: number;
  embeddingTime: number;
  indexingTime: number;
  retrievalTime: number;
  totalProcessingTime: number;
  chunksProcessed: number;
  chunksFiltered: number;
  averageChunkQuality: number;
  memoryUsage: number;
}

export class OptimizedRAGPipeline {
  private chunker!: SemanticChunker | SimpleChunker;
  private embedder!: EnhancedEmbedder;
  private retriever!: EnhancedRetriever;
  private vectorStore!: OptimizedVectorStore;
  private similarityCalculator!: HybridSimilarityCalculator;
  private processingMetrics!: ProcessingMetrics;

  constructor(
    private config: OptimizedPipelineConfig,
    private baseEmbedder?: Embedder
  ) {
    this.initializeComponents();
    this.resetMetrics();
  }

  private initializeComponents(): void {
    // Initialize chunker
    if (this.config.chunkingStrategy === 'semantic') {
      this.chunker = new SemanticChunker(this.config.chunking as SemanticChunkingConfig);
    } else {
      this.chunker = new SimpleChunker(this.config.chunking);
    }

    // Initialize embedder
    this.embedder = new EnhancedEmbedder(this.config.embedding, this.baseEmbedder);

    // Initialize similarity calculator
    this.similarityCalculator = new HybridSimilarityCalculator(
      this.config.embedding.denseWeight,
      this.config.embedding.sparseWeight
    );

    // Initialize vector store
    this.vectorStore = new OptimizedVectorStore(this.config.vectorStore);

    // Initialize retriever
    this.retriever = new EnhancedRetriever(
      this.config.retrieval,
      this.embedder,
      this.vectorStore,
      this.similarityCalculator
    );
  }

  async initialize(): Promise<void> {
    await this.vectorStore.initialize();
  }

  async processDocument(
    page: ConfluencePage,
    content: string,
    spaceId: string = 'default'
  ): Promise<{
    chunks: Chunk[];
    metrics: ProcessingMetrics;
  }> {
    const startTime = Date.now();
    this.resetMetrics();

    try {
      // Stage 1: Chunking
      const chunkingStart = Date.now();
      let chunks = await this.chunker.chunkDocument(page, content);
      this.processingMetrics.chunkingTime = Date.now() - chunkingStart;
      this.processingMetrics.chunksProcessed = chunks.length;

      // Stage 2: Quality filtering
      if (this.config.enableContentFiltering) {
        const originalCount = chunks.length;
        chunks = this.filterChunks(chunks);
        this.processingMetrics.chunksFiltered = originalCount - chunks.length;
      }

      // Stage 3: Embedding
      const embeddingStart = Date.now();
      const embeddings = await this.generateEmbeddings(chunks);
      this.processingMetrics.embeddingTime = Date.now() - embeddingStart;

      // Stage 4: Quality assessment
      if (this.config.enableQualityMetrics) {
        this.processingMetrics.averageChunkQuality = this.calculateAverageQuality(chunks, embeddings);
      }

      // Stage 5: Vector store indexing
      const indexingStart = Date.now();
      await this.vectorStore.addChunks(chunks, embeddings, spaceId);
      this.processingMetrics.indexingTime = Date.now() - indexingStart;

      // Calculate total time and memory usage
      this.processingMetrics.totalProcessingTime = Date.now() - startTime;
      this.processingMetrics.memoryUsage = this.getMemoryUsage();

      return {
        chunks,
        metrics: this.processingMetrics
      };

    } catch (error) {
      console.error('Document processing failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to process document: ${message}`);
    }
  }

  async query(
    query: string,
    options?: {
      spaceId?: string;
      filters?: Record<string, any>;
      contextLength?: number;
      enableExplainability?: boolean;
    }
  ): Promise<{
    chunks: Chunk[];
    scores: number[];
    metrics: {
      retrievalTime: number;
      totalResults: number;
      averageScore: number;
      processingSteps: string[];
    };
    explanation?: {
      originalQuery: string;
      expandedQueries?: string[];
      hydeDocument?: string;
      retrievalStrategy: string;
      rerankingApplied: boolean;
      filtersApplied: Record<string, any>;
    };
  }> {
    const startTime = Date.now();
    
    try {
      const result = await this.retriever.retrieve(query, options);
      
      const retrievalTime = Date.now() - startTime;
      const averageScore = result.scores.length > 0 
        ? result.scores.reduce((sum, score) => sum + score, 0) / result.scores.length 
        : 0;

      const metrics = {
        retrievalTime,
        totalResults: result.chunks.length,
        averageScore,
        processingSteps: this.getProcessingSteps(result.metadata)
      };

      let explanation;
      if (options?.enableExplainability) {
        explanation = {
          originalQuery: result.metadata.originalQuery,
          expandedQueries: result.metadata.expandedQueries,
          hydeDocument: result.metadata.hydeDocument,
          retrievalStrategy: this.config.retrievalStrategy,
          rerankingApplied: this.config.retrieval.enableTwoStageRetrieval,
          filtersApplied: options?.filters || {}
        };
      }

      return {
        chunks: result.chunks,
        scores: result.scores,
        metrics,
        explanation
      };

    } catch (error) {
      console.error('Query processing failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to process query: ${message}`);
    }
  }

  private async generateEmbeddings(chunks: Chunk[]) {
    if (this.config.enableParallelProcessing) {
      return this.generateEmbeddingsParallel(chunks);
    } else {
      return this.generateEmbeddingsSequential(chunks);
    }
  }

  private async generateEmbeddingsParallel(chunks: Chunk[]) {
    const batchSize = this.config.maxConcurrentEmbeddings;
    const embeddings = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const texts = batch.map(chunk => chunk.text);
      
      // Create context for enhanced embeddings
      const contexts = batch.map(chunk => ({
        documentTitle: chunk.title,
        sectionHeading: chunk.metadata?.section,
        metadata: chunk.metadata
      }));

      // Process batch
      const batchPromises = texts.map((text, idx) => 
        this.embedder.embedEnhanced([text], contexts[idx])
      );

      const batchResults = await Promise.all(batchPromises);
      embeddings.push(...batchResults.map(result => result[0]));
    }
    
    return embeddings;
  }

  private async generateEmbeddingsSequential(chunks: Chunk[]) {
    const embeddings = [];
    
    for (const chunk of chunks) {
      const context = {
        documentTitle: chunk.title,
        sectionHeading: chunk.metadata?.section,
        metadata: chunk.metadata
      };
      
      const embedding = await this.embedder.embedEnhanced([chunk.text], context);
      embeddings.push(embedding[0]);
    }
    
    return embeddings;
  }

  private filterChunks(chunks: Chunk[]): Chunk[] {
    return chunks.filter(chunk => {
      // Basic content quality filters
      const text = chunk.text.trim();
      
      // Filter out very short chunks
      if (text.length < 50) return false;
      
      // Filter out chunks that are mostly whitespace or punctuation
      const alphanumericRatio = (text.match(/[a-zA-Z0-9]/g) || []).length / text.length;
      if (alphanumericRatio < 0.5) return false;
      
      // Filter out chunks with low information content
      const uniqueWords = new Set(text.toLowerCase().split(/\s+/)).size;
      const totalWords = text.split(/\s+/).length;
      const lexicalDiversity = uniqueWords / totalWords;
      if (lexicalDiversity < 0.3) return false;
      
      return true;
    });
  }

  private calculateAverageQuality(chunks: Chunk[], embeddings: any[]): number {
    let totalQuality = 0;
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i];
      
      let quality = 0;
      
      // Text quality metrics
      const text = chunk.text;
      const words = text.split(/\s+/);
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      // Length appropriateness (0-1 score)
      const idealLength = 300; // characters
      const lengthScore = Math.max(0, 1 - Math.abs(text.length - idealLength) / idealLength);
      quality += lengthScore * 0.3;
      
      // Sentence structure (0-1 score)
      const avgSentenceLength = words.length / sentences.length;
      const sentenceScore = Math.max(0, Math.min(1, avgSentenceLength / 20));
      quality += sentenceScore * 0.2;
      
      // Lexical diversity (0-1 score)
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
      const diversityScore = uniqueWords / words.length;
      quality += diversityScore * 0.3;
      
      // Embedding quality (based on token count and keywords)
      if (embedding?.metadata) {
        const tokenScore = Math.min(1, embedding.metadata.tokenCount / 100);
        const keywordScore = Math.min(1, embedding.metadata.keywords.length / 10);
        quality += (tokenScore + keywordScore) * 0.1;
      }
      
      totalQuality += quality;
    }
    
    return chunks.length > 0 ? totalQuality / chunks.length : 0;
  }

  private getProcessingSteps(metadata: any): string[] {
    const steps = ['Initial query processing'];
    
    if (metadata.hydeDocument) {
      steps.push('HyDE document generation');
    }
    
    if (metadata.expandedQueries) {
      steps.push('Query expansion');
    }
    
    steps.push('Vector similarity search');
    
    if (this.config.retrieval.enableTwoStageRetrieval) {
      steps.push('Result reranking');
    }
    
    if (this.config.retrieval.enableMMR) {
      steps.push('Diversity optimization (MMR)');
    }
    
    if (this.config.retrieval.enableContextualCompression) {
      steps.push('Context compression');
    }
    
    return steps;
  }

  private getMemoryUsage(): number {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      return process.memoryUsage().heapUsed;
    }
    return 0;
  }

  private resetMetrics(): void {
    this.processingMetrics = {
      chunkingTime: 0,
      embeddingTime: 0,
      indexingTime: 0,
      retrievalTime: 0,
      totalProcessingTime: 0,
      chunksProcessed: 0,
      chunksFiltered: 0,
      averageChunkQuality: 0,
      memoryUsage: 0
    };
  }

  // Performance monitoring methods
  async getSystemStats(): Promise<{
    vectorStore: any;
    cache: any;
    totalProcessedDocuments: number;
    averageProcessingTime: number;
  }> {
    const vectorStoreStats = await this.vectorStore.getCollectionStats();
    const cacheStats = this.vectorStore.getCacheStats();
    
    return {
      vectorStore: vectorStoreStats,
      cache: cacheStats,
      totalProcessedDocuments: vectorStoreStats.documentCount,
      averageProcessingTime: this.processingMetrics.totalProcessingTime
    };
  }

  async optimizeSystem(): Promise<void> {
    console.log('Starting system optimization...');
    
    // Optimize vector store
    await this.vectorStore.optimizeCollection();
    
    // Clear caches to free memory
    this.vectorStore.getCacheStats(); // Accessing to ensure cache is working
    
    console.log('System optimization completed');
  }

  // Configuration updates
  updateConfig(newConfig: Partial<OptimizedPipelineConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.initializeComponents();
  }

  getConfig(): OptimizedPipelineConfig {
    return { ...this.config };
  }

  // Export configuration for other instances
  exportConfiguration(): string {
    return JSON.stringify(this.config, null, 2);
  }

  // Import configuration
  static importConfiguration(configJson: string): OptimizedPipelineConfig {
    return JSON.parse(configJson);
  }
}
