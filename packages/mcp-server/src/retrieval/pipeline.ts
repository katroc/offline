import type { Chunk, Filters, Citation } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LocalDocStore } from '../store/local-doc-store.js';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { Chunker } from './chunker.js';
import { rankDocumentsByRelevance } from './llm-search.js';

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
    if (this.localDocStore && this.localDocStore.size() > 0) {
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
        return { chunks: [], citations: [] };
      }
    }

    // 2. Use LLM to rank documents by relevance
    if (documents.length === 0) {
      console.log('No documents found for query');
      return { chunks: [], citations: [] };
    }

    const rankedResults = await rankDocumentsByRelevance(query, documents, Math.min(topK, documents.length));
    console.log(`LLM ranked ${rankedResults.length} documents by relevance`);

    // 3. Convert documents to chunks using the chunker, cap to topK total
    const chunks: Chunk[] = [];
    for (const result of rankedResults) {
      if (chunks.length >= topK) break;

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

        // Prefer the first chunk (usually the intro/most relevant), but include more if room remains
        for (const ch of docChunks) {
          if (chunks.length >= topK) break;
          chunks.push(ch);
        }
      } catch (e) {
        console.warn('Chunking failed for document:', doc.id, e);
      }
    }

    const citations = this.chunksTocitations(chunks);
    console.log(`Returning ${chunks.length} chunks and ${citations.length} citations`);
    return { chunks, citations };
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
        citationMap.set(key, {
          pageId: chunk.pageId,
          title: chunk.title,
          url: `https://confluence.local/pages/${chunk.pageId}`, // TODO: Get from config
          sectionAnchor: chunk.sectionAnchor
        });
      }
    }

    return Array.from(citationMap.values());
  }
}
