import type { Chunk } from '@app/shared';
import { ChromaClient, type Collection } from 'chromadb';
import type { EnhancedEmbedding } from '../llm/enhanced-embedder.js';

export interface VectorStoreConfig {
  // Multiple vector spaces
  enableMultipleSpaces: boolean;
  spaceConfigs: Record<string, {
    description: string;
    embeddingDimension: number;
    distanceFunction: 'cosine' | 'euclidean' | 'dot';
    indexType: 'hnsw' | 'flat';
  }>;
  
  // Dynamic search parameters
  enableAdaptiveK: boolean;
  minK: number;
  maxK: number;
  adaptiveThreshold: number;
  
  // Metadata optimization
  enableAdvancedFiltering: boolean;
  indexedMetadataFields: string[];
  
  // Hybrid search
  enableHybridSearch: boolean;
  denseWeight: number;
  sparseWeight: number;
  
  // Performance optimization
  enableBatching: boolean;
  batchSize: number;
  enableCaching: boolean;
  cacheSize: number;
}

export interface SearchOptions {
  k?: number;
  filters?: Record<string, any>;
  spaceId?: string;
  includeMetadata?: boolean;
  includeDistances?: boolean;
  hybridSearch?: boolean;
  adaptiveK?: boolean;
}

export interface SearchResult {
  chunk: Chunk;
  embedding: EnhancedEmbedding;
  distance: number;
  metadata?: any;
}

export class OptimizedVectorStore {
  private client: ChromaClient;
  private collections: Map<string, Collection> = new Map();
  private cache: Map<string, SearchResult[]> = new Map();
  
  constructor(
    private config: VectorStoreConfig,
    chromaUrl: string = 'http://chroma:8000'
  ) {
    this.client = new ChromaClient({ path: chromaUrl });
  }

  async initialize(): Promise<void> {
    try {
      // Test ChromaDB connection
      await this.client.heartbeat();
      console.log('✅ ChromaDB connection verified');
      
      // Initialize collections for different vector spaces
      for (const [spaceId, spaceConfig] of Object.entries(this.config.spaceConfigs)) {
        // If using a single space, honor CHROMA_COLLECTION for compatibility with existing data
        const name = (!this.config.enableMultipleSpaces && process.env.CHROMA_COLLECTION)
          ? String(process.env.CHROMA_COLLECTION)
          : `documents_${spaceId}`;
        
        try {
          const collection = await this.client.getOrCreateCollection({
            name,
            metadata: {
              description: spaceConfig.description,
            },
            // Avoid DefaultEmbeddingFunction requirement; we provide embeddings directly
            embeddingFunction: null,
          });
          this.collections.set(spaceId, collection);
          console.log(`✅ Initialized optimized collection: ${name}`);
        } catch (error) {
          console.warn(`Failed to initialize collection ${name}:`, error);
          throw error;
        }
      }
    } catch (error) {
      console.error('Failed to initialize OptimizedVectorStore:', error);
      throw new Error(`OptimizedVectorStore initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async ensureCollection(spaceId: string): Promise<void> {
    if (this.collections.has(spaceId)) {
      return;
    }

    // Use default configuration for spaces not explicitly configured
    const defaultConfig = {
      description: `Document space: ${spaceId}`,
      embeddingDimension: 384,
      distanceFunction: 'cosine' as const,
      indexType: 'hnsw' as const
    };

    const spaceConfig = this.config.spaceConfigs[spaceId] || defaultConfig;
    
    // If using a single space, honor CHROMA_COLLECTION for compatibility with existing data
    const name = (!this.config.enableMultipleSpaces && process.env.CHROMA_COLLECTION)
      ? String(process.env.CHROMA_COLLECTION)
      : `documents_${spaceId}`;
      
    try {
      const collection = await this.client.getOrCreateCollection({
        name,
        metadata: {
          description: spaceConfig.description,
        },
        // Avoid DefaultEmbeddingFunction requirement; we provide embeddings directly
        embeddingFunction: null,
      });
      this.collections.set(spaceId, collection);
      console.log(`✅ Created/retrieved collection: ${name}`);
    } catch (error) {
      console.error(`Failed to create collection for space ${spaceId}:`, error);
      throw error;
    }
  }

  async addChunks(
    chunks: Chunk[],
    embeddings: EnhancedEmbedding[],
    spaceId: string = 'default'
  ): Promise<void> {
    // Get or create collection on-demand
    let collection = this.collections.get(spaceId);
    if (!collection) {
      console.log(`Creating collection for space: ${spaceId}`);
      await this.ensureCollection(spaceId);
      collection = this.collections.get(spaceId);
      if (!collection) {
        throw new Error(`Failed to create collection for space ${spaceId}`);
      }
    }

    if (this.config.enableBatching) {
      await this.addChunksBatched(collection, chunks, embeddings);
    } else {
      await this.addChunksDirect(collection, chunks, embeddings);
    }

    // Clear cache for this space
    this.clearCacheForSpace(spaceId);
  }

  private async addChunksBatched(
    collection: Collection,
    chunks: Chunk[],
    embeddings: EnhancedEmbedding[]
  ): Promise<void> {
    const batchSize = this.config.batchSize;
    
    for (let i = 0; i < chunks.length; i += batchSize) {
      const chunkBatch = chunks.slice(i, i + batchSize);
      const embeddingBatch = embeddings.slice(i, i + batchSize);
      
      const ids = chunkBatch.map(chunk => chunk.id);
      const denseEmbeddings = embeddingBatch.map(emb => emb.dense);
      const metadatas = chunkBatch.map(chunk => this.prepareMetadata(chunk, embeddingBatch[chunkBatch.indexOf(chunk)]));
      const documents = chunkBatch.map(chunk => chunk.text);

      await collection.add({
        ids,
        embeddings: denseEmbeddings,
        metadatas,
        documents
      });
    }
  }

  private async addChunksDirect(
    collection: Collection,
    chunks: Chunk[],
    embeddings: EnhancedEmbedding[]
  ): Promise<void> {
    const ids = chunks.map(chunk => chunk.id);
    const denseEmbeddings = embeddings.map(emb => emb.dense);
    const metadatas = chunks.map((chunk, idx) => this.prepareMetadata(chunk, embeddings[idx]));
    const documents = chunks.map(chunk => chunk.text);

    await collection.add({
      ids,
      embeddings: denseEmbeddings,
      metadatas,
      documents
    });
  }

  private prepareMetadata(chunk: Chunk, embedding: EnhancedEmbedding): any {
    const metadata: any = {
      pageId: chunk.pageId,
      space: chunk.space,
      title: chunk.title,
      version: chunk.version,
      updatedAt: chunk.updatedAt,
      url: chunk.url,
      sectionAnchor: chunk.sectionAnchor || '',
      
      // Enhanced metadata from embedding
      embeddingLevel: embedding.metadata.level,
      hasContext: embedding.metadata.hasContext,
      tokenCount: embedding.metadata.tokenCount,
      keywords: embedding.metadata.keywords.join(','),
      
      // Original chunk metadata
      ...chunk.metadata
    };

    // Store sparse embeddings as metadata (ChromaDB doesn't support multiple vectors per document natively)
    if (embedding.sparse) {
      const sparseTerms: string[] = [];
      const sparseWeights: number[] = [];
      
      for (const [term, weight] of embedding.sparse.entries()) {
        sparseTerms.push(term);
        sparseWeights.push(weight);
      }
      
      metadata.sparseTerms = sparseTerms.join(',');
      metadata.sparseWeights = sparseWeights.join(',');
    }

    return metadata;
  }

  async search(
    queryEmbedding: number[] | EnhancedEmbedding,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const {
      k = 10,
      filters = {},
      spaceId = 'default',
      includeMetadata = true,
      includeDistances = true,
      hybridSearch = this.config.enableHybridSearch,
      adaptiveK = this.config.enableAdaptiveK
    } = options;

    // Generate cache key
    const cacheKey = this.generateCacheKey(queryEmbedding, options);
    
    if (this.config.enableCaching && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // Get or create collection on-demand
    let collection = this.collections.get(spaceId);
    if (!collection) {
      console.log(`Creating collection for search in space: ${spaceId}`);
      await this.ensureCollection(spaceId);
      collection = this.collections.get(spaceId);
      if (!collection) {
        throw new Error(`Failed to create collection for space ${spaceId}`);
      }
    }

    let finalK = k;
    if (adaptiveK) {
      finalK = await this.calculateAdaptiveK(queryEmbedding, collection, k);
    }

    let results: SearchResult[];

    if (hybridSearch && this.isEnhancedEmbedding(queryEmbedding)) {
      results = await this.performHybridSearch(
        queryEmbedding as EnhancedEmbedding,
        collection,
        finalK,
        filters
      );
    } else {
      const embedding = Array.isArray(queryEmbedding) 
        ? queryEmbedding 
        : (queryEmbedding as EnhancedEmbedding).dense;
        
      results = await this.performDenseSearch(
        embedding,
        collection,
        finalK,
        filters,
        includeMetadata,
        includeDistances
      );
    }

    // Cache results
    if (this.config.enableCaching) {
      this.addToCache(cacheKey, results);
    }

    return results;
  }

  private async performHybridSearch(
    queryEmbedding: EnhancedEmbedding,
    collection: Collection,
    k: number,
    filters: Record<string, any>
  ): Promise<SearchResult[]> {
    // Dense search
    const denseResults = await this.performDenseSearch(
      queryEmbedding.dense,
      collection,
      Math.min(k * 2, 100), // Retrieve more candidates for hybrid ranking
      filters,
      true,
      true
    );

    // If we have sparse embeddings, perform sparse search
    if (queryEmbedding.sparse) {
      const sparseResults = await this.performSparseSearch(
        queryEmbedding.sparse,
        collection,
        Math.min(k * 2, 100),
        filters
      );

      // Combine and rerank
      return this.combineHybridResults(
        denseResults,
        sparseResults,
        this.config.denseWeight,
        this.config.sparseWeight,
        k
      );
    }

    return denseResults.slice(0, k);
  }

  private async performDenseSearch(
    embedding: number[],
    collection: Collection,
    k: number,
    filters: Record<string, any>,
    includeMetadata: boolean = true,
    includeDistances: boolean = true
  ): Promise<SearchResult[]> {
    const whereClause = this.buildWhereClause(filters);
    
    const queryResult = await collection.query({
      queryEmbeddings: [embedding],
      nResults: k,
      where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
      include: ['documents', 'metadatas', 'distances'].filter(item => {
        if (item === 'metadatas') {return includeMetadata;}
        if (item === 'distances') {return includeDistances;}
        return true;
      }) as any
    });

    const results: SearchResult[] = [];
    const ids = queryResult.ids[0] || [];
    const documents = queryResult.documents?.[0] || [];
    const metadatas = queryResult.metadatas?.[0] || [];
    const distances = queryResult.distances?.[0] || [];

    for (let i = 0; i < ids.length; i++) {
      const rawMeta = (metadatas[i] || {}) as Record<string, unknown>;
      const getStr = (k: string): string | undefined => {
        const v = rawMeta[k];
        return typeof v === 'string' ? v : undefined;
      };
      const getBool = (k: string, def = false): boolean => {
        const v = rawMeta[k];
        return typeof v === 'boolean' ? v : def;
      };
      const getNum = (k: string, def = 0): number => {
        const v = rawMeta[k];
        return typeof v === 'number' ? v : def;
      };
      
      // Reconstruct chunk from stored data
      const labelsStr = getStr('labels');
      // Fallbacks for snake_case metadata used by default pipeline
      const pageId = getStr('pageId') || getStr('page_id') || '';
      const updatedAt = getStr('updatedAt') || getStr('updated_at') || '';
      const sectionAnchor = getStr('sectionAnchor') || getStr('section_anchor') || undefined;
      const chunk: Chunk = {
        id: String(ids[i]),
        pageId,
        space: getStr('space') || 'default',
        title: getStr('title') || '',
        text: (documents[i] as string) || '',
        version: getNum('version', 0),
        updatedAt,
        url: getStr('url') || undefined,
        sectionAnchor,
        labels: labelsStr ? labelsStr.split(',') : [],
        metadata: {
          section: getStr('section'),
          level: getNum('level', 0),
          hasCode: getBool('hasCode'),
          hasTables: getBool('hasTables'),
          hasLists: getBool('hasLists'),
          chunkIndex: getNum('chunkIndex', 0),
          overlapStart: getBool('overlapStart'),
          overlapEnd: getBool('overlapEnd')
        }
      };

      // Reconstruct enhanced embedding
      const enhancedEmbedding: EnhancedEmbedding = {
        dense: [], // We don't store the dense embedding back
        metadata: {
          level: (getStr('embeddingLevel') as any) || 'chunk',
          hasContext: getBool('hasContext'),
          tokenCount: getNum('tokenCount', 0),
          keywords: (getStr('keywords') || '').split(',').filter(Boolean)
        }
      };

      // Reconstruct sparse embedding if available
      const sparseTermsStr = getStr('sparseTerms');
      const sparseWeightsStr = getStr('sparseWeights');
      if (sparseTermsStr && sparseWeightsStr) {
        const terms = sparseTermsStr.split(',');
        const weights = sparseWeightsStr.split(',').map(Number);
        
        const sparse = new Map<string, number>();
        for (let j = 0; j < terms.length && j < weights.length; j++) {
          sparse.set(terms[j], weights[j]);
        }
        enhancedEmbedding.sparse = sparse;
      }

      results.push({
        chunk,
        embedding: enhancedEmbedding,
        distance: distances[i] || 0,
        metadata: includeMetadata ? rawMeta : undefined
      });
    }

    return results;
  }

  private async performSparseSearch(
    sparseQuery: Map<string, number>,
    collection: Collection,
    k: number,
    filters: Record<string, any>
  ): Promise<SearchResult[]> {
    // ChromaDB doesn't natively support sparse search, so we simulate it
    // by filtering documents that contain query terms
    const queryTerms = Array.from(sparseQuery.keys());
    const whereClause = this.buildWhereClause({
      ...filters,
      // Use ChromaDB's text search capabilities
      $or: queryTerms.map(term => ({
        sparseTerms: { $contains: term }
      }))
    });

    // For now, fall back to dense search with term-based filtering
    // In a production system, you'd want a proper sparse search implementation
    return [];
  }

  private combineHybridResults(
    denseResults: SearchResult[],
    sparseResults: SearchResult[],
    denseWeight: number,
    sparseWeight: number,
    k: number
  ): SearchResult[] {
    const combinedScores = new Map<string, {result: SearchResult; score: number}>();

    // Add dense results with weight
    for (const result of denseResults) {
      const score = (1 - result.distance) * denseWeight; // Convert distance to similarity
      combinedScores.set(result.chunk.id, { result, score });
    }

    // Add sparse results with weight
    for (const result of sparseResults) {
      const existing = combinedScores.get(result.chunk.id);
      const sparseScore = (1 - result.distance) * sparseWeight;
      
      if (existing) {
        existing.score += sparseScore;
      } else {
        combinedScores.set(result.chunk.id, { result, score: sparseScore });
      }
    }

    // Sort by combined score and return top k
    return Array.from(combinedScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(item => ({
        ...item.result,
        distance: 1 - item.score // Convert back to distance-like score
      }));
  }

  private async calculateAdaptiveK(
    queryEmbedding: number[] | EnhancedEmbedding,
    collection: Collection,
    requestedK: number
  ): Promise<number> {
    // Perform a small search to estimate result quality
    const embedding = Array.isArray(queryEmbedding) 
      ? queryEmbedding 
      : (queryEmbedding as EnhancedEmbedding).dense;

    const testResults = await collection.query({
      queryEmbeddings: [embedding],
      nResults: Math.min(this.config.maxK, 50),
      include: ['distances']
    });

    const distances: number[] = (testResults.distances?.[0] as number[]) || [];
    if (distances.length === 0) {return requestedK;}

    // Count results above threshold
    const goodResults = distances.filter((d: number) => d <= this.config.adaptiveThreshold).length;
    
    // Adaptive K based on result quality distribution
    if (goodResults >= requestedK) {
      return requestedK;
    } else if (goodResults > this.config.minK) {
      return Math.max(goodResults, this.config.minK);
    } else {
      // If very few good results, increase K to get more candidates
      return Math.min(this.config.maxK, requestedK * 2);
    }
  }

  private buildWhereClause(filters: Record<string, any>): any {
    const where: any = {};

    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null) {continue;}

      if (Array.isArray(value)) {
        where[key] = { $in: value };
      } else if (typeof value === 'object') {
        where[key] = value; // Assume it's already a ChromaDB operator
      } else {
        where[key] = { $eq: value };
      }
    }

    return where;
  }

  private generateCacheKey(
    queryEmbedding: number[] | EnhancedEmbedding,
    options: SearchOptions
  ): string {
    const embedding = Array.isArray(queryEmbedding) 
      ? queryEmbedding 
      : (queryEmbedding as EnhancedEmbedding).dense;
    
    // Create a more robust hash using full embedding
    // Use a simple hash function to avoid crypto dependency
    const hashEmbedding = (arr: number[]): string => {
      let hash = 0;
      const str = arr.map(x => Math.round(x * 10000)).join(',');
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return hash.toString(36);
    };
    
    const embeddingKey = hashEmbedding(embedding);
    const optionsKey = JSON.stringify(options, Object.keys(options).sort());
    
    return `${embeddingKey}-${optionsKey}`;
  }

  private addToCache(key: string, results: SearchResult[]): void {
    if (this.cache.size >= this.config.cacheSize) {
      // Remove oldest entry (simple FIFO)
      const it = this.cache.keys().next();
      if (!it.done) {
        this.cache.delete(it.value);
      }
    }
    
    this.cache.set(key, results);
  }

  private clearCacheForSpace(spaceId: string): void {
    // Clear all cache entries (in production, you'd want more granular cache invalidation)
    this.cache.clear();
  }

  private isEnhancedEmbedding(embedding: any): embedding is EnhancedEmbedding {
    return embedding && typeof embedding === 'object' && 'dense' in embedding;
  }

  // Utility methods for performance monitoring
  async getCollectionStats(spaceId: string = 'default'): Promise<{
    documentCount: number;
    indexSize: string;
    averageVectorSize: number;
  }> {
    const collection = this.collections.get(spaceId);
    if (!collection) {
      throw new Error(`Collection for space ${spaceId} not found`);
    }

    const count = await collection.count();
    
    return {
      documentCount: count,
      indexSize: 'N/A', // ChromaDB doesn't expose this directly
      averageVectorSize: this.config.spaceConfigs[spaceId]?.embeddingDimension || 0
    };
  }

  async optimizeCollection(spaceId: string = 'default'): Promise<void> {
    // ChromaDB handles optimization automatically
    console.log(`Collection ${spaceId} optimization requested (handled automatically by ChromaDB)`);
  }

  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.cacheSize,
      hitRate: 0 // Would need to track hits/misses to calculate
    };
  }
}
