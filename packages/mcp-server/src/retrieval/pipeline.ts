import type { Chunk, Filters, Citation } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LocalDocStore } from '../store/local-doc-store.js';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { Chunker } from './chunker.js';
import type { Embedder } from './interfaces.js';
import { GoogleEmbedder } from '../llm/google-embedder.js';
import { rankDocumentsByRelevance, simpleTextRelevanceScore } from './llm-search.js';

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

export class DefaultRAGPipeline implements RAGPipeline {
  private embedder: Embedder;

  constructor(
    private documentClient: DocumentSourceClient,
    private vectorStore: VectorStore,
    private chunker: Chunker,
    private localDocStore?: LocalDocStore,
    embedder?: Embedder
  ) {
    this.embedder = embedder || new GoogleEmbedder();
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
    const limited = variants.slice(0, 1 + maxFallbacks); // cap attempts
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
      if (queryEmbedding.length > 0) {
        // Fetch more candidates than needed, then downselect with MMR
        const minCandidates = Math.max(topK, parseInt(process.env.MIN_VECTOR_RESULTS || '3', 10) || 3);
        const maxCandidatesCap = Math.max(10, parseInt(process.env.MAX_VECTOR_CANDIDATES || '50', 10) || 50);
        const poolMult = Math.max(2, parseInt(process.env.MMR_POOL_MULTIPLIER || String(topK * 2), 10) || topK * 5);
        const candidateK = Math.min(Math.max(topK * 5, poolMult, minCandidates), maxCandidatesCap);
        const vectorResults = await this.vectorStore.searchSimilar(queryEmbedding[0], filters, candidateK);
        console.log(`Vector search candidates=${vectorResults.length} (requested ${candidateK})`);

        // Dynamic threshold (optional informational logging)
        const baseThreshold = isFinite(Number(process.env.RELEVANCE_THRESHOLD))
          ? Number(process.env.RELEVANCE_THRESHOLD)
          : 0.5;
        const useAdaptive = String(process.env.ADAPTIVE_THRESHOLD || '').toLowerCase() === 'true';
        const maxScore = vectorResults.reduce((m, r) => Math.max(m, r.score ?? 0), 0);
        const threshold = useAdaptive ? Math.max(baseThreshold, 0.6 * maxScore) : baseThreshold;
        const above = vectorResults.filter(r => r.score >= threshold).length;
          console.log(`Vector search: ${above}/${vectorResults.length} >= threshold (${threshold}${useAdaptive ? ' adaptive' : ''})`);

        if (vectorResults.length > 0) {
          // Check global relevance threshold from environment before proceeding
          const envThreshold = isFinite(Number(process.env.RELEVANCE_THRESHOLD)) 
            ? Number(process.env.RELEVANCE_THRESHOLD) 
            : 0.2; // Much more permissive default for general questions
          const maxVectorScore = Math.max(...vectorResults.map(r => r.score ?? 0));
          
          if (maxVectorScore <= envThreshold - 0.001) { // Allow small precision tolerance
            console.log(`Vector results do not meet global threshold ${envThreshold} (max: ${maxVectorScore.toFixed(3)}). Returning empty results.`);
            return { chunks: [], citations: [] };
          }

          const mmr = this.applyMMR(vectorResults, queryEmbedding[0], Math.min(topK * 2, Math.max(topK, vectorResults.length)));
          // Optional lexical floor to reduce off-topic sources
          const kwFloor = Number.isFinite(Number(process.env.MIN_KEYWORD_SCORE)) ? Number(process.env.MIN_KEYWORD_SCORE) : 0.0;
          const rescored = mmr.map(r => ({
            r,
            kw: simpleTextRelevanceScore(query, r.chunk.text, r.chunk.title)
          }));
          const filtered = rescored
            .filter(x => x.kw >= kwFloor)
            .sort((a, b) => (0.3 * (b.r.score ?? 0)) + (0.7 * b.kw) - ((0.3 * (a.r.score ?? 0)) + (0.7 * a.kw)))
            .slice(0, topK)
            .map(x => x.r);
          const chunks = (filtered.length > 0 ? filtered : mmr.slice(0, topK)).map(r => r.chunk);
          this.triggerLazyValidation(chunks);
          const citations = this.chunksTocitations(chunks);
          console.log(`Returning ${chunks.length} chunks from vector MMR${kwFloor > 0 ? ` with kwFloor=${kwFloor}` : ''}`);
          return { chunks, citations };
        }
      }
    } catch (error) {
      console.warn('Vector search failed, falling back to keyword search:', error);
    }

    // 2. Fallback to keyword-based document search
    let documents: DocumentSource[] = [];
    const preferLive = String(process.env.PREFER_LIVE_SEARCH || '').toLowerCase() === 'true';

    if (!preferLive && this.localDocStore && this.localDocStore.size() > 0) {
      documents = this.localDocStore.queryCandidates(
        query,
        {
          space: filters.space,
          labels: filters.labels,
          updatedAfter: filters.updatedAfter,
          limit: 30,
          start: 0
        },
        30
      );
      console.log(`Found ${documents.length} candidate documents from local index`);
    } else {
      try {
        const searchResult = await this.documentClient.searchDocuments({
          query,
          space: filters.space,
          labels: filters.labels,
          updatedAfter: filters.updatedAfter,
          limit: 15 // Get more candidates for LLM ranking
        });
        documents = searchResult.documents;
        console.log(`Found ${documents.length} candidate documents from live search`);
      } catch (error) {
        console.warn('Live document search failed:', error);
        // Fallback to local store if available
        if (!preferLive && this.localDocStore && this.localDocStore.size() > 0) {
          documents = this.localDocStore.queryCandidates(
            query,
            {
              space: filters.space,
              labels: filters.labels,
              updatedAfter: filters.updatedAfter,
              limit: 30,
              start: 0
            },
            30
          );
          console.log(`Fallback: ${documents.length} candidate documents from local index`);
        } else {
          return { chunks: [], citations: [] };
        }
      }
    }

    // 2. Use LLM to rank documents by relevance
    if (documents.length === 0) {
      console.log('No documents found for query');
      return { chunks: [], citations: [] };
    }

    const rankedResults = await rankDocumentsByRelevance(query, documents, Math.min(topK, documents.length), model);
    console.log(`LLM ranked ${rankedResults.length} documents by relevance`);

    // Check global relevance threshold for keyword search results  
    const envThreshold = isFinite(Number(process.env.RELEVANCE_THRESHOLD)) 
      ? Number(process.env.RELEVANCE_THRESHOLD) 
      : 0.2; // Much more permissive default for general questions
    const globalThreshold = envThreshold;
    const maxDocumentScore = rankedResults.length > 0 ? Math.max(...rankedResults.map(r => r.relevanceScore)) : 0;
    
    if (maxDocumentScore <= globalThreshold - 0.001) { // Allow small precision tolerance
      console.log(`Keyword search results do not meet global threshold ${globalThreshold} (max: ${maxDocumentScore.toFixed(3)}). Returning empty results.`);
      return { chunks: [], citations: [] };
    }

    // Index documents in background for future vector searches
    this.indexDocumentsInBackground(documents);

    // 3. Chunk documents and score chunks by relevance to the query
    type ScoredChunk = { chunk: Chunk; docId: string; docScore: number; chunkScore: number; combined: number };
    const scored: ScoredChunk[] = [];

    for (const result of rankedResults) {
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
        for (const ch of docChunks) {
          const chunkScore = simpleTextRelevanceScore(query, ch.text, ch.title);
          // Blend doc-level LLM score with chunk-level keyword score
          const combined = 0.6 * result.relevanceScore + 0.4 * chunkScore;
          scored.push({ chunk: ch, docId: doc.id, docScore: result.relevanceScore, chunkScore, combined });
        }
      } catch (e) {
        console.warn('Chunking failed for document:', doc.id, e);
      }
    }

    if (scored.length === 0) {
      console.log('No chunks produced from ranked documents');
      return { chunks: [], citations: [] };
    }

    // 4. Select topK chunks globally with per-document cap to preserve diversity
    const perDocCap = Math.max(1, Math.min(3, Math.floor(topK / 2) || 1));
    const byDocPicked: Record<string, number> = {};
    const selected: Chunk[] = [];

    for (const s of scored.sort((a, b) => b.combined - a.combined)) {
      if (selected.length >= topK) break;
      const count = byDocPicked[s.docId] || 0;
      if (count >= perDocCap) continue;
      selected.push(s.chunk);
      byDocPicked[s.docId] = count + 1;
    }

    const citations = this.chunksTocitations(selected);
    console.log(`Returning ${selected.length} chunks and ${citations.length} citations`);
    return { chunks: selected, citations };
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    // 1. Convert to ConfluencePage format (temporary adaptation)
    const page = {
      id: document.id,
      title: document.title,
      spaceKey: document.spaceKey,
      version: document.version,
      labels: document.labels,
      updatedAt: document.updatedAt,
      url: document.url
    };

    // 2. Chunk the document
    const chunks = await this.chunker.chunkDocument(page, document.content);

    // 3. Generate embeddings for chunks
    console.log(`Generating embeddings for ${chunks.length} chunks from document: ${document.title}`);
    const includeTitle = String(process.env.EMBED_INCLUDE_TITLE || 'true').toLowerCase() !== 'false';
    const titleWeight = Math.max(0, parseInt(process.env.EMBED_TITLE_WEIGHT || '2', 10) || 2);
    const includeLabels = String(process.env.EMBED_INCLUDE_LABELS || 'false').toLowerCase() === 'true';
    const includeAnchor = String(process.env.EMBED_INCLUDE_ANCHOR || 'false').toLowerCase() === 'true';
    const buildEmbedText = (ch: Chunk) => {
      const parts: string[] = [];
      if (includeTitle && page.title) {
        // Simple weighting by repetition to bias the vector slightly towards title semantics
        parts.push(Array(Math.max(1, titleWeight)).fill(page.title).join('\n'));
      }
      if (includeAnchor && ch.sectionAnchor) parts.push(String(ch.sectionAnchor));
      if (includeLabels && Array.isArray(page.labels) && page.labels.length > 0) parts.push(page.labels.join(' '));
      parts.push(ch.text);
      return parts.filter(Boolean).join('\n\n');
    };
    const texts = chunks.map(buildEmbedText);
    const embeddings = await this.embedder.embed(texts);
    
    // 4. Add embeddings to chunks
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].vector = embeddings[i];
    }
    
    // 5. Store chunks with embeddings in vector store
    await this.vectorStore.upsertChunks(chunks);
    console.log(`Indexed ${chunks.length} chunks with embeddings for: ${document.title}`);
  }

  async deleteDocument(pageId: string): Promise<void> {
    await this.vectorStore.deleteByPageId(pageId);
  }

  private async liveSearchAndIndex(query: string, filters: Filters): Promise<void> {
    try {
      // Search live documents
      const searchResult = await this.documentClient.searchDocuments({
        query,
        space: filters.space,
        labels: filters.labels,
        updatedAfter: filters.updatedAfter,
        limit: 10 // Reasonable limit for live indexing
      });

      // Index found documents
      const indexPromises = searchResult.documents.map(doc => this.indexDocument(doc));
      await Promise.allSettled(indexPromises); // Don't fail if some docs fail to index
    } catch (error) {
      // Log but don't throw - we can still proceed with existing vector store content
      console.warn('Live search and index failed:', error);
    }
  }

  private applyMMR(results: VectorSearchResult[], queryVector: number[], topK: number): VectorSearchResult[] {
    if (results.length <= topK) return results;

    const selected: VectorSearchResult[] = [];
    const remaining = [...results];

    // Always include the top result
    if (remaining.length > 0) {
      selected.push(remaining.shift()!);
    }

    // Select remaining results based on MMR
    const lambda = Number.isFinite(Number(process.env.MMR_LAMBDA)) ? Number(process.env.MMR_LAMBDA) : 0.7;
    const lam = Math.max(0, Math.min(1, lambda));
    while (selected.length < topK && remaining.length > 0) {
      let bestIndex = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevanceScore = candidate.score;

        // Calculate diversity score (minimum similarity to already selected)
        let minSimilarity = 1.0;
        for (const selectedResult of selected) {
          if (candidate.chunk.vector && selectedResult.chunk.vector) {
            const similarity = this.cosineSimilarity(candidate.chunk.vector, selectedResult.chunk.vector);
            minSimilarity = Math.min(minSimilarity, similarity);
          }
        }
        const diversityScore = 1 - minSimilarity;

        // MMR score: balance relevance and diversity (lambda from env)
        const mmrScore = lam * relevanceScore + (1 - lam) * diversityScore;

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

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private chunksTocitations(chunks: Chunk[]): Citation[] {
    // IMPORTANT: Maintain 1:1 order with input chunks so [n] citations in the
    // generated answer map directly to this array's indices (n-1).
    const citations: Citation[] = [];

    for (const chunk of chunks) {
      // Always construct absolute URLs
      const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
      const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;

      let rawUrl: string;
      if (chunk.url && chunk.url.startsWith('http')) {
        // Already absolute URL
        rawUrl = chunk.url;
      } else if (chunk.url) {
        // Relative URL - make it absolute
        rawUrl = `${baseUrl}${chunk.url}`;
      } else {
        // Better fallback: include space key when available to match Confluence WebUI URLs
        if (chunk.space) {
          rawUrl = `${baseUrl}/spaces/${chunk.space}/pages/${chunk.pageId}`;
        } else {
          rawUrl = `${baseUrl}/pages/${chunk.pageId}`;
        }
      }

      const url = chunk.sectionAnchor ? `${rawUrl}#${chunk.sectionAnchor}` : rawUrl;

      // Create snippet from chunk text (first 200 chars)
      const snippet = chunk.text.length > 200
        ? chunk.text.slice(0, 197) + '...'
        : chunk.text;

      citations.push({
        pageId: chunk.pageId,
        title: chunk.title,
        url,
        sectionAnchor: chunk.sectionAnchor,
        snippet
      });
    }

    return citations;
  }

  /**
   * Index documents in background for future vector searches
   */
  private async indexDocumentsInBackground(documents: DocumentSource[]): Promise<void> {
    // Don't wait for this - run in background
    setTimeout(async () => {
      try {
        console.log(`Background indexing ${documents.length} documents...`);
        for (const doc of documents) {
          await this.indexDocument(doc);
        }
        console.log(`Background indexing completed for ${documents.length} documents`);
      } catch (error) {
        console.warn('Background indexing failed:', error);
      }
    }, 100); // Small delay to not block the main response
  }

  /**
   * Lazy validation: refresh any pages whose chunks are older than TTL.
   * Runs in the background and does not block the response.
   */
  private triggerLazyValidation(chunks: Chunk[]): void {
    const ttlDays = parseInt(process.env.CHUNK_TTL_DAYS || '7', 10);
    if (Number.isNaN(ttlDays) || ttlDays <= 0) return; // disabled

    const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
    const stalePageIds = new Set<string>();

    for (const ch of chunks) {
      if (!ch.indexedAt) {
        stalePageIds.add(ch.pageId);
        continue;
      }
      const t = Date.parse(ch.indexedAt);
      if (isNaN(t) || t < cutoffMs) {
        stalePageIds.add(ch.pageId);
      }
    }

    if (stalePageIds.size === 0) return;

    setTimeout(async () => {
      try {
        console.log(`Lazy refresh: re-indexing ${stalePageIds.size} page(s) due to staleness`);
        for (const pageId of stalePageIds) {
          try {
            const doc = await this.documentClient.getDocumentById(pageId);
            await this.indexDocument(doc);
          } catch (err) {
            console.warn(`Lazy refresh failed for page ${pageId}:`, err);
          }
        }
      } catch (error) {
        console.warn('Lazy refresh batch failed:', error);
      }
    }, 50);
  }
}
