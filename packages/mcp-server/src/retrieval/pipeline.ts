import type { Chunk, Filters, Citation } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LocalDocStore } from '../store/local-doc-store.js';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { Chunker } from './chunker.js';
import { rankDocumentsByRelevance, simpleTextRelevanceScore } from './llm-search.js';

export interface RAGPipeline {
  retrieveForQuery(query: string, filters: Filters, topK: number): Promise<RetrievalResult>;
  indexDocument(document: DocumentSource): Promise<void>;
  deleteDocument(pageId: string): Promise<void>;
}

export interface RetrievalResult {
  chunks: Chunk[];
  citations: Citation[];
}

export class DefaultRAGPipeline implements RAGPipeline {
  constructor(
    private documentClient: DocumentSourceClient,
    private vectorStore: VectorStore,
    private chunker: Chunker,
    private localDocStore?: LocalDocStore
  ) {}

  async retrieveForQuery(query: string, filters: Filters, topK: number): Promise<RetrievalResult> {
    console.log(`RAG Pipeline: Retrieving for query "${query}" with filters:`, filters);

    // 1. Get candidate documents
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

    const rankedResults = await rankDocumentsByRelevance(query, documents, Math.min(topK, documents.length));
    console.log(`LLM ranked ${rankedResults.length} documents by relevance`);

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

    // 3. Skip embedding for now - we're using LLM-based search instead
    console.log(`Indexing ${chunks.length} chunks from document: ${document.title}`);
    
    // 4. Store chunks in vector store (without embeddings for now)
    // await this.vectorStore.upsertChunks(chunks);
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

        // MMR score: balance relevance and diversity (lambda = 0.7)
        const mmrScore = 0.7 * relevanceScore + 0.3 * diversityScore;

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
    const citationMap = new Map<string, Citation>();

    for (const chunk of chunks) {
      const key = `${chunk.pageId}-${chunk.sectionAnchor || 'main'}`;
      if (!citationMap.has(key)) {
        // Prefer chunk.url if present; otherwise build from env base URL
        const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
        const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
        const rawUrl = chunk.url || `${baseUrl}/pages/${chunk.pageId}`;
        const url = chunk.sectionAnchor ? `${rawUrl}#${chunk.sectionAnchor}` : rawUrl;
        citationMap.set(key, {
          pageId: chunk.pageId,
          title: chunk.title,
          url,
          sectionAnchor: chunk.sectionAnchor
        });
      }
    }

    return Array.from(citationMap.values());
  }
}
