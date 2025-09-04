import type { RagResponse, Filters } from '@app/shared';
import type { DocumentSource } from './sources/interfaces.js';
import type { ValidRagQuery } from './validation.js';
import { chatCompletion, type ChatMessage } from './llm/chat.js';
import { ConfluenceClient } from './sources/confluence.js';
import { crawlSpace } from './sources/confluence-crawler.js';
import { LocalDocStore } from './store/local-doc-store.js';
import { MockVectorStore, LanceDBVectorStore } from './retrieval/vector-store.js';
import { SimpleChunker } from './retrieval/chunker.js';
import { DefaultRAGPipeline } from './retrieval/pipeline.js';

// Singleton instances (in production, these would be properly managed)
let ragPipeline: DefaultRAGPipeline | null = null;
let localDocStore: LocalDocStore | null = null;

async function getRagPipeline(): Promise<DefaultRAGPipeline> {
  if (!ragPipeline) {
    // Initialize document source client
    const confluenceClient = new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
      username: process.env.CONFLUENCE_USERNAME || '',
      apiToken: process.env.CONFLUENCE_API_TOKEN || ''
    });

    // Initialize vector store - use real LanceDB if path configured, otherwise mock
    const lanceDbPath = process.env.LANCEDB_PATH || './data/lancedb';
    const useLanceDB = process.env.USE_REAL_VECTORDB !== 'false'; // Default to true
    
    let vectorStore;
    if (useLanceDB) {
      vectorStore = new LanceDBVectorStore({
        dbPath: lanceDbPath,
        tableName: 'confluence_chunks'
      });
      try {
        await vectorStore.initialize();
        console.log(`Initialized LanceDB vector store at: ${lanceDbPath}`);
      } catch (error) {
        console.warn('Failed to initialize LanceDB, falling back to mock store:', error);
        vectorStore = new MockVectorStore();
      }
    } else {
      console.log('Using mock vector store (set USE_REAL_VECTORDB=true for LanceDB)');
      vectorStore = new MockVectorStore();
    }

    // Initialize chunker
    const chunker = new SimpleChunker({
      targetChunkSize: 800,
      overlap: 200,
      maxChunkSize: 1200
    });

    // Initialize local doc store
    if (!localDocStore) localDocStore = new LocalDocStore();

    ragPipeline = new DefaultRAGPipeline(confluenceClient, vectorStore, chunker, localDocStore);
  }
  return ragPipeline;
}

export async function ragQuery(query: ValidRagQuery): Promise<RagResponse> {
  const useLlm = (process.env.LLM_BASE_URL || '').length > 0;
  const useRealRAG = process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_USERNAME;
  
  console.log('DEBUG: Environment check:', {
    CONFLUENCE_BASE_URL: process.env.CONFLUENCE_BASE_URL,
    CONFLUENCE_USERNAME: process.env.CONFLUENCE_USERNAME,
    useLlm,
    useRealRAG
  });

  // Use mock citations if Confluence not configured
  if (!useRealRAG) {
    const mockCitations = [
      { pageId: '12345', title: 'Getting Started', url: 'https://confluence.local/pages/12345', sectionAnchor: 'introduction' },
      { pageId: '67890', title: 'Architecture Overview', url: 'https://confluence.local/pages/67890', sectionAnchor: 'rag-pipeline' },
    ];
    
    if (!useLlm) {
      return { answer: `Mock answer for: ${query.question} (Configure LLM_BASE_URL and CONFLUENCE_* env vars for full RAG)`, citations: mockCitations };
    }

    // Use LLM with mock context
    const contextText = mockCitations
      .map((citation, i) => `[${i + 1}] ${citation.title}${citation.sectionAnchor ? ` (${citation.sectionAnchor})` : ''}\nThis is mock content for the ${citation.title} page.`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a factual, concise assistant.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order from the context.',
        'Place citations immediately after the sentence they support.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    try {
      const answer = await chatCompletion([system, user]);
      return { answer, citations: mockCitations };
    } catch (err) {
      console.warn('LLM call failed:', err);
      return { answer: `Mock answer for: ${query.question} (LLM call failed: ${err instanceof Error ? err.message : 'Unknown error'})`, citations: mockCitations };
    }
  }

  try {
    // Build filters from query
    const filters: Filters = {
      space: query.space,
      labels: query.labels,
      updatedAfter: query.updatedAfter
    };

    // Retrieve relevant context
    const pipeline = await getRagPipeline();
    const retrieval = await pipeline.retrieveForQuery(query.question, filters, query.topK);

    if (!useLlm) {
      return { 
        answer: `Retrieved ${retrieval.chunks.length} chunks for: ${query.question}`, 
        citations: retrieval.citations 
      };
    }

    // Build context from chunks
    const contextText = retrieval.chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.title}${chunk.sectionAnchor ? ` (${chunk.sectionAnchor})` : ''}\n${chunk.text}`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a factual, concise assistant.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order from the context.',
        'Place citations immediately after the sentence they support.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    const answer = await chatCompletion([system, user]);
    return { answer, citations: retrieval.citations };

  } catch (err) {
    console.warn('RAG query failed:', err);
    return { 
      answer: `Failed to process query: ${query.question}. Error: ${err instanceof Error ? err.message : 'Unknown error'}`, 
      citations: [] 
    };
  }
}

export async function syncConfluence(opts?: { spaces?: string[]; updatedAfter?: string; maxPages?: number; pageSize?: number }): Promise<{ total: number; bySpace: Record<string, number> }> {
  const spaces = (opts?.spaces && opts.spaces.length > 0)
    ? opts!.spaces
    : (process.env.CONFLUENCE_SPACES || '').split(',').map(s => s.trim()).filter(Boolean);

  if (spaces.length === 0) {
    throw new Error('No spaces provided. Set CONFLUENCE_SPACES env or pass spaces in request.');
  }

  const client = new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
    username: process.env.CONFLUENCE_USERNAME || '',
    apiToken: process.env.CONFLUENCE_API_TOKEN || ''
  });

  if (!localDocStore) localDocStore = new LocalDocStore();

  const bySpace: Record<string, number> = {};
  let total = 0;
  for (const key of spaces) {
    try {
      const docs = await crawlSpace(client, key, { updatedAfter: opts?.updatedAfter, maxPages: opts?.maxPages, pageSize: opts?.pageSize });
      localDocStore.upsertAll(docs);
      bySpace[key] = docs.length;
      total += docs.length;
    } catch (err) {
      console.warn(`Sync failed for space ${key}:`, err);
      bySpace[key] = 0;
    }
  }

  console.log(`Sync completed. Total documents: ${total}`);
  return { total, bySpace };
}

// Ingest pre-fetched documents (e.g., pasted from Confluence API) into local store
export async function ingestDocuments(docs: DocumentSource[]): Promise<{ total: number }>{
  if (!docs || !Array.isArray(docs)) {
    throw new Error('Invalid documents payload');
  }
  if (!localDocStore) localDocStore = new LocalDocStore();
  localDocStore.upsertAll(docs);
  return { total: docs.length };
}

// Helper to convert a subset of Confluence API page objects to DocumentSource
export function mapConfluenceApiPagesToDocuments(pages: any[]): DocumentSource[] {
  const results: DocumentSource[] = [];
  for (const apiPage of pages || []) {
    try {
      const doc: DocumentSource = {
        id: String(apiPage.id),
        title: String(apiPage.title || ''),
        spaceKey: String(apiPage?.space?.key || apiPage?.spaceKey || ''),
        version: Number(apiPage?.version?.number || apiPage?.version || 1),
        labels: Array.isArray(apiPage?.metadata?.labels?.results)
          ? apiPage.metadata.labels.results.map((l: any) => String(l.name)).filter(Boolean)
          : Array.isArray(apiPage?.labels) ? apiPage.labels.map((l: any) => String(l)).filter(Boolean) : [],
        updatedAt: String(apiPage?.version?.when || apiPage?.updatedAt || new Date().toISOString()),
        url: apiPage?._links?.base
          ? `${apiPage._links.base}${apiPage._links.webui}`
          : (apiPage?._links?.webui || apiPage?.url || undefined),
        content: String(apiPage?.body?.storage?.value || apiPage?.content || '')
      };
      results.push(doc);
    } catch {
      // skip malformed entries
    }
  }
  return results;
}
