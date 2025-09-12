import type { Chunk, Filters, Citation } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LocalDocStore } from '../store/local-doc-store.js';
import type { VectorStore } from './vector-store.js';
import type { Chunker } from './chunker.js';
import type { Embedder } from './interfaces.js';
import { GoogleEmbedder } from '../llm/google-embedder.js';
import { rankDocumentsByRelevance, simpleTextRelevanceScore } from './llm-search.js';
import { SimpleChunker } from './chunker.js';

export interface RAGPipeline {
  retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult>;
  indexDocument(document: DocumentSource): Promise<void>;
  deleteDocument(pageId: string): Promise<void>;
}

export interface RetrievalResult {
  chunks: Chunk[];
  citations: Citation[];
}

export interface UnifiedPipelineConfig {
  strategy: 'default' | 'smart' | 'optimized';
  documentClient: DocumentSourceClient;
  vectorStore?: VectorStore;
  chunker?: Chunker;
  embedder?: Embedder;
  localDocStore?: LocalDocStore;
  optimizedOptions?: {
    enableContentFiltering: boolean;
  };
}

export class UnifiedRAGPipeline implements RAGPipeline {
  private strategy: RetrievalStrategy;

  constructor(private config: UnifiedPipelineConfig) {
    this.strategy = this.createStrategy();
  }

  private createStrategy(): RetrievalStrategy {
    switch (this.config.strategy) {
      case 'smart':
        return new SmartRetrievalStrategy(this.config);
      case 'optimized':
        return new OptimizedRetrievalStrategy(this.config);
      default:
        return new DefaultRetrievalStrategy(this.config);
    }
  }

  async retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    return this.strategy.retrieveForQuery(queries, filters, topK, model, conversationId, intent);
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    return this.strategy.indexDocument(document);
  }

  async deleteDocument(pageId: string): Promise<void> {
    return this.strategy.deleteDocument(pageId);
  }

  updateStrategy(strategy: 'default' | 'smart' | 'optimized'): void {
    this.config.strategy = strategy;
    this.strategy = this.createStrategy();
  }
}

interface RetrievalStrategy {
  retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult>;
  indexDocument(document: DocumentSource): Promise<void>;
  deleteDocument(pageId: string): Promise<void>;
}

class DefaultRetrievalStrategy implements RetrievalStrategy {
  private embedder: Embedder;

  constructor(private config: UnifiedPipelineConfig) {
    this.embedder = config.embedder || new GoogleEmbedder();
  }

  async retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    _conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    const variants = Array.isArray(queries) ? queries : [queries];
    const maxFallbacks = Math.max(0, parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10) || 3);
    const limited = variants.slice(0, 1 + maxFallbacks);

    if (intent) {
      console.log(`Default Pipeline intent: ${intent.intent} (conf=${intent.confidence?.toFixed?.(2) ?? intent.confidence})`);
    }

    let lastResult: RetrievalResult = { chunks: [], citations: [] };
    for (let i = 0; i < limited.length; i++) {
      const q = limited[i];
      console.log(`RAG Pipeline: Attempt ${i + 1}/${limited.length} with query: "${q}"`);
      const res = await this.retrieveSingleQuery(q, filters, topK, model);
      if (res.chunks.length > 0) return res;
      lastResult = res;
    }
    return lastResult;
  }

  private async retrieveSingleQuery(query: string, filters: Filters, topK: number, model?: string): Promise<RetrievalResult> {
    console.log(`RAG Pipeline single-query retrieval for "${query}" with filters:`, filters);

    // 1. Try vector search first
    try {
      const queryEmbedding = await this.embedder.embed([query]);
      if (queryEmbedding.length > 0 && this.config.vectorStore) {
        const minCandidates = Math.max(topK, parseInt(process.env.MIN_VECTOR_RESULTS || '3', 10) || 3);
        const maxCandidatesCap = Math.max(10, parseInt(process.env.MAX_VECTOR_CANDIDATES || '50', 10) || 50);
        const candidateK = Math.min(Math.max(topK * 5, minCandidates), maxCandidatesCap);
        const vectorResults = await this.config.vectorStore.searchSimilar(queryEmbedding[0], filters, candidateK, query);

        if (vectorResults.length > 0) {
          const mmr = this.applyMMR(vectorResults, queryEmbedding[0], Math.min(topK * 2, Math.max(topK, vectorResults.length)));
          const chunks = mmr.slice(0, topK).map(r => r.chunk);
          const citations = this.chunksToCitations(chunks);
          console.log(`Returning ${chunks.length} chunks from vector MMR`);
          return { chunks, citations };
        }
      }
    } catch (error) {
      console.warn('Vector search failed, falling back to keyword search:', error);
    }

    // 2. Fallback to keyword-based document search
    let documents: DocumentSource[] = [];
    const preferLive = String(process.env.PREFER_LIVE_SEARCH || '').toLowerCase() === 'true';

    if (!preferLive && this.config.localDocStore && this.config.localDocStore.size() > 0) {
      documents = this.config.localDocStore.queryCandidates(
        query,
        { space: filters.space, labels: filters.labels, updatedAfter: filters.updatedAfter, limit: 30, start: 0 },
        30
      );
    } else {
      try {
        const searchResult = await this.config.documentClient.searchDocuments({
          query, ...filters, limit: 15
        });
        documents = searchResult.documents;
      } catch (error) {
        console.warn('Live document search failed:', error);
        return { chunks: [], citations: [] };
      }
    }

    // 3. Use LLM to rank documents by relevance
    if (documents.length === 0) return { chunks: [], citations: [] };

    const rankedResults = await rankDocumentsByRelevance(query, documents, Math.min(topK, documents.length), model);
    const chunks = await this.documentsToChunks(query, rankedResults, topK);
    const citations = this.chunksToCitations(chunks);

    return { chunks, citations };
  }

  private async documentsToChunks(query: string, rankedResults: any[], topK: number): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    const chunker = this.config.chunker || new SimpleChunker({ targetChunkSize: 800, maxChunkSize: 1200, overlap: 200 });

    for (const result of rankedResults.slice(0, topK)) {
      const doc = result.document;
      const page = {
        id: doc.id,
        title: doc.title,
        spaceKey: doc.spaceKey,
        version: doc.version,
        labels: doc.labels,
        updatedAt: doc.updatedAt,
        url: doc.url
      };

      try {
        const docChunks = await chunker.chunkDocument(page, doc.content);
        const scored = docChunks.map(ch => ({
          chunk: ch,
          score: simpleTextRelevanceScore(query, ch.text, ch.title)
        })).sort((a, b) => b.score - a.score);

        if (scored.length > 0) chunks.push(scored[0].chunk);
        if (chunks.length >= topK) break;
      } catch (e) {
        console.warn('Chunking failed for document:', doc.id, e);
      }
    }

    return chunks;
  }

  private applyMMR(results: any[], queryVector: number[], topK: number): any[] {
    if (results.length <= topK) return results;

    const selected: any[] = [];
    const remaining = [...results];

    if (remaining.length > 0) selected.push(remaining.shift()!);

    const lambda = Number.isFinite(Number(process.env.MMR_LAMBDA)) ? Number(process.env.MMR_LAMBDA) : 0.7;

    while (selected.length < topK && remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevanceScore = candidate.score || 0;
        let minSimilarity = 1.0;

        for (const selectedResult of selected) {
          if (candidate.chunk.vector && selectedResult.chunk.vector) {
            const similarity = this.cosineSimilarity(candidate.chunk.vector, selectedResult.chunk.vector);
            minSimilarity = Math.min(minSimilarity, similarity);
          }
        }

        const diversityScore = 1 - minSimilarity;
        const mmrScore = lambda * relevanceScore + (1 - lambda) * diversityScore;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0]);
    }

    return selected;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private chunksToCitations(chunks: Chunk[]): Citation[] {
    return chunks.map(chunk => {
      const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
      const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
      const url = chunk.sectionAnchor ? `${baseUrl}/pages/${chunk.pageId}#${chunk.sectionAnchor}` : `${baseUrl}/pages/${chunk.pageId}`;
      const snippet = chunk.text.length > 200 ? chunk.text.slice(0, 197) + '...' : chunk.text;

      return {
        pageId: chunk.pageId,
        title: chunk.title,
        url,
        sectionAnchor: chunk.sectionAnchor,
        snippet
      };
    });
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    if (!this.config.vectorStore || !this.config.chunker) return;

    const page = {
      id: document.id,
      title: document.title,
      spaceKey: document.spaceKey,
      version: document.version,
      labels: document.labels,
      updatedAt: document.updatedAt,
      url: document.url
    };

    const chunks = await this.config.chunker.chunkDocument(page, document.content);
    const texts = chunks.map(chunk => chunk.text);
    const embeddings = await this.embedder.embed(texts);

    for (let i = 0; i < chunks.length; i++) {
      chunks[i].vector = embeddings[i];
    }

    await this.config.vectorStore.upsertChunks(chunks);
  }

  async deleteDocument(pageId: string): Promise<void> {
    if (this.config.vectorStore) {
      await this.config.vectorStore.deleteByPageId(pageId);
    }
  }
}

class SmartRetrievalStrategy implements RetrievalStrategy {
  private chunker = new SimpleChunker({ targetChunkSize: 800, maxChunkSize: 1200, overlap: 200 });

  constructor(private config: UnifiedPipelineConfig) {}

  async retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    const variants = Array.isArray(queries) ? queries : [queries];
    const maxFallbacks = Math.max(0, parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10) || 3);
    const limited = variants.slice(0, 1 + maxFallbacks);

    if (intent) {
      console.log(`Smart Pipeline intent: ${intent.intent} (conf=${intent.confidence?.toFixed?.(2) ?? intent.confidence})`);
    }

    let lastResult: RetrievalResult = { chunks: [], citations: [] };
    for (let i = 0; i < limited.length; i++) {
      const q = limited[i];
      console.log(`Smart RAG: Attempt ${i + 1}/${limited.length} with query: "${q}"`);
      const res = await this.retrieveSingleQuery(q, filters, topK, model);
      if (res.chunks.length > 0) return res;
      lastResult = res;
    }
    return lastResult;
  }

  private async retrieveSingleQuery(query: string, filters: Filters, topK: number, model?: string): Promise<RetrievalResult> {
    try {
      // Get broad document set
      const broadDocuments = await this.getBroadDocumentSet(query, filters);
      if (broadDocuments.length === 0) return { chunks: [], citations: [] };

      // Use LLM to rank documents by relevance
      const rankedResults = await rankDocumentsByRelevance(query, broadDocuments, Math.min(topK, broadDocuments.length), model);
      const chunks = await this.documentsToChunks(query, rankedResults, topK);
      const citations = this.chunksToCitations(chunks);

      return { chunks, citations };
    } catch (error) {
      console.warn('Smart analysis failed, falling back to CQL:', error);
      return await this.cqlFallback(query, filters, topK, model);
    }
  }

  private async getBroadDocumentSet(query: string, filters: Filters): Promise<DocumentSource[]> {
    try {
      const response = await this.config.documentClient.searchDocuments({
        query: this.buildBroadQuery(query), ...filters, limit: 20
      });
      return response.documents.slice(0, 20);
    } catch (error) {
      console.warn('Broad keyword search failed:', error);
      return [];
    }
  }

  private buildBroadQuery(query: string): string {
    const stop = new Set(['what','how','the','can','you','help','with','need','all','my','being','have','has','had']);
    const tokens = query.toLowerCase()
      .replace(/[^a-z0-9\s-\.]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(w => !stop.has(w))
      .filter(w => w.length >= 3);

    return Array.from(new Set(tokens)).slice(0, 4).join(' ');
  }

  private async documentsToChunks(query: string, rankedResults: any[], topK: number): Promise<Chunk[]> {
    const chunks: Chunk[] = [];

    for (const result of rankedResults.slice(0, topK)) {
      const doc = result.document;
      const page = {
        id: doc.id,
        title: doc.title,
        spaceKey: doc.spaceKey,
        version: doc.version,
        labels: doc.labels,
        updatedAt: doc.updatedAt,
        url: doc.url
      };

      try {
        const docChunks = await this.chunker.chunkDocument(page, doc.content);
        const scored = docChunks.map(ch => ({
          chunk: ch,
          score: simpleTextRelevanceScore(query, ch.text, ch.title)
        })).sort((a, b) => b.score - a.score);

        if (scored.length > 0) chunks.push(scored[0].chunk);
      } catch (e) {
        console.warn('Chunking failed for document:', doc.id, e);
      }

      if (chunks.length >= topK) break;
    }

    return chunks;
  }

  private async cqlFallback(query: string, filters: Filters, topK: number, model?: string): Promise<RetrievalResult> {
    try {
      const response = await this.config.documentClient.searchDocuments({
        query, ...filters, limit: topK
      });

      if (response.documents.length === 0) return { chunks: [], citations: [] };

      const chunks: Chunk[] = [];
      for (const doc of response.documents.slice(0, topK)) {
        const page = {
          id: doc.id,
          title: doc.title,
          spaceKey: doc.spaceKey,
          version: doc.version,
          labels: doc.labels,
          updatedAt: doc.updatedAt,
          url: doc.url
        };

        const docChunks = await this.chunker.chunkDocument(page, doc.content);
        const scored = docChunks.map(ch => ({
          chunk: ch,
          score: simpleTextRelevanceScore(query, ch.text, ch.title)
        })).sort((a, b) => b.score - a.score);

        if (scored.length > 0) chunks.push(scored[0].chunk);
      }

      return { chunks, citations: this.chunksToCitations(chunks) };
    } catch (error) {
      console.error('CQL fallback also failed:', error);
      return { chunks: [], citations: [] };
    }
  }

  private chunksToCitations(chunks: Chunk[]): Citation[] {
    return chunks.map(chunk => {
      const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
      const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
      const url = chunk.sectionAnchor ? `${baseUrl}/pages/${chunk.pageId}#${chunk.sectionAnchor}` : `${baseUrl}/pages/${chunk.pageId}`;
      const snippet = chunk.text.length > 200 ? chunk.text.slice(0, 197) + '...' : chunk.text;

      return {
        pageId: chunk.pageId,
        title: chunk.title,
        url,
        sectionAnchor: chunk.sectionAnchor,
        snippet
      };
    });
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    // Smart pipeline doesn't use local indexing
  }

  async deleteDocument(pageId: string): Promise<void> {
    // Smart pipeline doesn't use local indexing
  }
}

class OptimizedRetrievalStrategy implements RetrievalStrategy {
  private chunker: Chunker;
  private embedder: Embedder;

  constructor(private config: UnifiedPipelineConfig) {
    this.chunker = config.chunker || new SimpleChunker({ targetChunkSize: 800, maxChunkSize: 1200, overlap: 200 });
    this.embedder = config.embedder || new GoogleEmbedder();
  }

  async retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    const query = Array.isArray(queries) ? queries[0] : queries;

    if (!this.config.vectorStore) {
      return { chunks: [], citations: [] };
    }

    try {
      const queryEmbedding = await this.embedder.embed([query]);
      if (queryEmbedding.length === 0) return { chunks: [], citations: [] };

      const vectorResults = await this.config.vectorStore.searchSimilar(queryEmbedding[0], filters, topK, query);
      const chunks = vectorResults.map(r => r.chunk);
      const citations = this.chunksToCitations(chunks);

      return { chunks, citations };
    } catch (error) {
      console.error('Optimized retrieval failed:', error);
      return { chunks: [], citations: [] };
    }
  }

  private chunksToCitations(chunks: Chunk[]): Citation[] {
    return chunks.map(chunk => {
      const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
      const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
      const url = chunk.sectionAnchor ? `${baseUrl}/pages/${chunk.pageId}#${chunk.sectionAnchor}` : `${baseUrl}/pages/${chunk.pageId}`;
      const snippet = chunk.text.length > 200 ? chunk.text.slice(0, 197) + '...' : chunk.text;

      return {
        pageId: chunk.pageId,
        title: chunk.title,
        url,
        sectionAnchor: chunk.sectionAnchor,
        snippet
      };
    });
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    if (!this.config.vectorStore) return;

    const page = {
      id: document.id,
      title: document.title,
      spaceKey: document.spaceKey,
      version: document.version,
      labels: document.labels,
      updatedAt: document.updatedAt,
      url: document.url
    };

    let chunks = await this.chunker.chunkDocument(page, document.content);

    // Apply content filtering if enabled
    if (this.config.optimizedOptions?.enableContentFiltering) {
      chunks = this.filterChunks(chunks);
    }

    const texts = chunks.map(chunk => chunk.text);
    const embeddings = await this.embedder.embed(texts);

    for (let i = 0; i < chunks.length; i++) {
      chunks[i].vector = embeddings[i];
    }

    await this.config.vectorStore.upsertChunks(chunks);
  }

  private filterChunks(chunks: Chunk[]): Chunk[] {
    return chunks.filter(chunk => {
      const text = chunk.text.trim();
      if (text.length < 50) return false;

      const alphanumericRatio = (text.match(/[a-zA-Z0-9]/g) || []).length / text.length;
      if (alphanumericRatio < 0.5) return false;

      const uniqueWords = new Set(text.toLowerCase().split(/\s+/)).size;
      const totalWords = text.split(/\s+/).length;
      const lexicalDiversity = uniqueWords / totalWords;
      if (lexicalDiversity < 0.3) return false;

      return true;
    });
  }

  async deleteDocument(pageId: string): Promise<void> {
    if (this.config.vectorStore) {
      await this.config.vectorStore.deleteByPageId(pageId);
    }
  }
}

// Export the unified pipeline as the main interface
export { UnifiedRAGPipeline as DefaultRAGPipeline };