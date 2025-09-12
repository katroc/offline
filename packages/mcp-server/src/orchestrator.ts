import { fileURLToPath } from 'url';
import path from 'node:path';
import type { RagResponse, Filters, Citation } from '@app/shared';
import type { ValidRagQuery } from './validation.js';
import { chatCompletion, chatCompletionStream, type ChatMessage } from './llm/chat.js';
import { ConfluenceClient } from './sources/confluence.js';
import { LocalDocStore } from './store/local-doc-store.js';
import { MockVectorStore, LanceDBVectorStore, ChromaVectorStore } from './retrieval/vector-store.js';
import { SimpleChunker } from './retrieval/chunker.js';
import { DefaultRAGPipeline, type RetrievalResult } from './retrieval/pipeline.js';
import { SmartRAGPipeline } from './retrieval/smart-pipeline.js';
import { OptimizedRAGIntegration } from './retrieval/optimized-rag-integration.js';
import { GoogleEmbedder } from './llm/google-embedder.js';
import { QueryIntentProcessor, QueryIntent } from './retrieval/query-intent-processor.js';

// Singleton instances (in production, these would be properly managed)
let ragPipeline: DefaultRAGPipeline | null = null;
let optimizedPipeline: OptimizedRAGIntegration | null = null;
let smartPipeline: SmartRAGPipeline | null = null;
let localDocStore: LocalDocStore | null = null;

async function getSmartPipeline(): Promise<SmartRAGPipeline> {
  if (!smartPipeline) {
    // Initialize document source client
    const confluenceClient = new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
      username: process.env.CONFLUENCE_USERNAME || '',
      apiToken: process.env.CONFLUENCE_API_TOKEN || ''
    });

    smartPipeline = new SmartRAGPipeline(confluenceClient);
    console.log('Initialized Smart RAG Pipeline with LLM document analysis');
  }
  return smartPipeline;
}

async function getOptimizedPipeline(): Promise<OptimizedRAGIntegration> {
  if (!optimizedPipeline) {
    // First ensure we have the default pipeline as fallback
    const fallbackPipeline = await getRagPipeline();
    
    // Initialize document source client
    const confluenceClient = new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
      username: process.env.CONFLUENCE_USERNAME || '',
      apiToken: process.env.CONFLUENCE_API_TOKEN || ''
    });

    // Use same vector store setup as default pipeline
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const useRealVectorDB = process.env.USE_REAL_VECTORDB !== 'false';
    const vectorStoreType = process.env.VECTOR_STORE || 'chroma'; // Default to Chroma for optimized pipeline
    
    let vectorStore;
    if (useRealVectorDB && vectorStoreType.toLowerCase() === 'chroma') {
      vectorStore = new ChromaVectorStore({
        host: process.env.CHROMA_HOST,
        port: process.env.CHROMA_PORT ? parseInt(process.env.CHROMA_PORT, 10) : undefined,
        ssl: process.env.CHROMA_SSL === 'true',
        collectionName: process.env.CHROMA_COLLECTION || 'optimized_chunks',
        auth: process.env.CHROMA_AUTH_PROVIDER && process.env.CHROMA_AUTH_CREDENTIALS ? {
          provider: process.env.CHROMA_AUTH_PROVIDER as 'token' | 'basic',
          credentials: process.env.CHROMA_AUTH_CREDENTIALS
        } : undefined
      });
      try {
        await vectorStore.initialize();
        console.log(`✅ Initialized optimized Chroma vector store`);
      } catch (error) {
        console.warn('Failed to initialize Chroma for optimized pipeline:', error);
        vectorStore = new MockVectorStore();
      }
    } else {
      console.log('Using mock vector store for optimized pipeline');
      vectorStore = new MockVectorStore();
    }

    // Initialize chunker (will be upgraded by optimized pipeline)
    const chunker = new SimpleChunker({
      targetChunkSize: 800,
      overlap: 200,
      maxChunkSize: 1200
    });

    // Get local doc store
    if (!localDocStore) {localDocStore = new LocalDocStore();}

    // Create optimized integration with same embedder as fallback
    optimizedPipeline = new OptimizedRAGIntegration(
      confluenceClient,
      vectorStore,
      chunker,
      localDocStore,
      fallbackPipeline
    );

    await optimizedPipeline.initialize();
    console.log('🚀 Initialized OptimizedRAG Integration');
  }
  return optimizedPipeline;
}

async function getRagPipeline(): Promise<DefaultRAGPipeline> {
  if (!ragPipeline) {
    // Initialize document source client
    const confluenceClient = new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
      username: process.env.CONFLUENCE_USERNAME || '',
      apiToken: process.env.CONFLUENCE_API_TOKEN || ''
    });

    // Initialize vector store - support LanceDB, Chroma, or mock
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '../../../');
    const useRealVectorDB = process.env.USE_REAL_VECTORDB !== 'false'; // Default to true
    const vectorStoreType = process.env.VECTOR_STORE || 'lancedb';
    
    let vectorStore;
    if (useRealVectorDB) {
      if (vectorStoreType.toLowerCase() === 'chroma') {
        vectorStore = new ChromaVectorStore({
          host: process.env.CHROMA_HOST,
          port: process.env.CHROMA_PORT ? parseInt(process.env.CHROMA_PORT, 10) : undefined,
          ssl: process.env.CHROMA_SSL === 'true',
          collectionName: process.env.CHROMA_COLLECTION || 'confluence_chunks',
          auth: process.env.CHROMA_AUTH_PROVIDER && process.env.CHROMA_AUTH_CREDENTIALS ? {
            provider: process.env.CHROMA_AUTH_PROVIDER as 'token' | 'basic',
            credentials: process.env.CHROMA_AUTH_CREDENTIALS
          } : undefined
        });
        try {
          await vectorStore.initialize();
          console.log(`Initialized Chroma vector store at: ${process.env.CHROMA_HOST || 'localhost'}:${process.env.CHROMA_PORT || 8000}`);
        } catch (error) {
          console.warn('Failed to initialize Chroma, falling back to mock store:', error);
          vectorStore = new MockVectorStore();
        }
      } else {
        // Default to LanceDB
        const lanceEnv = process.env.LANCEDB_PATH || './data/lancedb';
        const lanceDbPath = path.isAbsolute(lanceEnv) ? lanceEnv : path.resolve(repoRoot, lanceEnv);
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
      }
    } else {
      console.log('Using mock vector store (set USE_REAL_VECTORDB=true for real vector stores)');
      vectorStore = new MockVectorStore();
    }

    // Initialize chunker
    const chunker = new SimpleChunker({
      targetChunkSize: 800,
      overlap: 200,
      maxChunkSize: 1200
    });

    // Initialize local doc store
    if (!localDocStore) {localDocStore = new LocalDocStore();}

    // Initialize embedder with Google's new model
    const embedder = new GoogleEmbedder();
    console.log(`Initialized Google embedder with ${embedder.dimensions} dimensions`);

    ragPipeline = new DefaultRAGPipeline(confluenceClient, vectorStore, chunker, localDocStore, embedder);
  }
  return ragPipeline;
}

export async function ragQuery(query: ValidRagQuery): Promise<RagResponse> {
  const useLlm = (process.env.LLM_BASE_URL || '').length > 0;
  const useRealRAG = process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_USERNAME;

  // Use mock citations if Confluence not configured
  if (!useRealRAG) {
    const mockCitations = [
      { pageId: '12345', title: 'Getting Started', url: 'https://confluence.local/pages/12345', sectionAnchor: 'introduction' },
      { pageId: '67890', title: 'Architecture Overview', url: 'https://confluence.local/pages/67890', sectionAnchor: 'rag-pipeline' },
    ];
    
    if (!useLlm) {
      const { displayCitations, indexMap } = dedupeCitations(mockCitations);
      return { 
        answer: `Mock answer for: ${query.question} (Configure LLM_BASE_URL and CONFLUENCE_* env vars for full RAG)`, 
        citations: mockCitations,
        displayCitations,
        citationIndexMap: indexMap
      };
    }

    // Use LLM with mock context
    const contextText = mockCitations
      .map((citation, i) => `[${i + 1}] ${citation.title}${citation.sectionAnchor ? ` (${citation.sectionAnchor})` : ''}\nThis is mock content for the ${citation.title} page.`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a knowledgeable documentation assistant that provides well-structured, helpful responses.',
        'IMPORTANT: Format your response using clear markdown structure with appropriate headings, lists, and code blocks.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Structure your response based on the question type:',
        '- For troubleshooting: Use "## Problem" and "## Solution" sections',
        '- For how-to questions: Use numbered steps with clear headings',
        '- For explanations: Use appropriate headings to break down concepts',
        '- For comparisons: Use tables or structured lists to compare options',
        'Use **bold** for important terms and `code` formatting for technical elements.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order.',
        'Always include bracketed citations immediately after the specific sentence they support. Only cite numbers that exist in the provided context.',
        'Cite ONLY sources that directly support your statements. Do not include unrelated sources.',
        'Limit to at most 3 distinct citations. If only one source is relevant, cite only that one.',
        'At the end of your answer, include a final line: "Sources: [n][, [m][, [k]]]" listing ONLY the citations you used.',
        'Use blockquotes (>) for important notes or warnings.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    try {
    const answer = await chatCompletion([system, user], { model: query.model });
    const { displayCitations, indexMap } = dedupeCitations(mockCitations);
    return { answer, citations: mockCitations, displayCitations, citationIndexMap: indexMap };
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

    // Optional intent processing to normalize queries and generate fallbacks
    const enableIntent = (process.env.ENABLE_INTENT_PROCESSING || 'true').toLowerCase() !== 'false';
    const minIntentConf = isFinite(Number(process.env.INTENT_CONFIDENCE_THRESHOLD))
      ? Number(process.env.INTENT_CONFIDENCE_THRESHOLD)
      : 0.7;
    const maxFallbacks = Math.max(0, parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10) || 3);
    let queriesToTry: string[] = [query.question];
    let intentCtx: { intent: string; confidence: number; normalizedQuery: string } | undefined;
    if (enableIntent) {
      const intentProcessor = new QueryIntentProcessor();
      const intent = intentProcessor.processQuery(query.question);
      intentCtx = { intent: intent.intent, confidence: intent.confidence, normalizedQuery: intent.normalizedQuery };
      console.log(`Query intent: ${intent.intent} (confidence: ${intent.confidence.toFixed(2)})`);
      console.log(`Normalized variant: "${intent.normalizedQuery}"`);

      // Build query variants in priority order: original -> normalized (if different) -> fallbacks
      const variants: string[] = [];
      if (intent.normalizedQuery && intent.normalizedQuery !== query.question && intent.confidence >= minIntentConf) {
        variants.push(intent.normalizedQuery);
      }
      const fallbacks = intent.fallbackQueries.slice(0, maxFallbacks);
      queriesToTry = [query.question, ...variants, ...fallbacks].filter((v, i, a) => v && a.indexOf(v) === i);
    }

    // Clean, deterministic pipeline selection logic
    const useOptimizedPipeline = process.env.USE_OPTIMIZED_PIPELINE === 'true';
    const useSmartFallback = process.env.USE_SMART_PIPELINE !== 'false'; // Default to true
    console.log(`🔍 Pipeline selection: OPTIMIZED=${useOptimizedPipeline}, SMART_FALLBACK=${useSmartFallback}`);
    
    let retrieval: RetrievalResult | undefined;
    let pipelineUsed = 'unknown';
    
    // Primary: Try Optimized Pipeline if enabled
    if (useOptimizedPipeline) {
      console.log('🚀 Trying OptimizedRAG Pipeline with advanced embeddings and chunking...');
      try {
        const optimizedPipe = await getOptimizedPipeline();
        retrieval = await optimizedPipe.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
        
        if (retrieval.chunks.length > 0) {
          console.log(`✅ OptimizedRAG succeeded with ${retrieval.chunks.length} chunks`);
          pipelineUsed = 'optimized';
        } else {
          console.log('⚠️ OptimizedRAG returned no results, falling back...');
          retrieval = undefined; // Clear for fallback
        }
      } catch (error) {
        console.warn('⚠️ OptimizedRAG failed with error, falling back:', error);
        retrieval = undefined; // Clear for fallback
      }
    }
    
    // Fallback: Smart Pipeline if no results from optimized or if optimized disabled
    if (!retrieval && useSmartFallback) {
      console.log('🧠 Using Smart Pipeline with LLM document analysis...');
      try {
        const smartPipe = await getSmartPipeline();
        retrieval = await smartPipe.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
        
        if (retrieval.chunks.length > 0) {
          console.log(`✅ Smart Pipeline succeeded with ${retrieval.chunks.length} chunks`);
          pipelineUsed = 'smart';
        } else {
          console.log('⚠️ Smart Pipeline returned no results');
        }
      } catch (error) {
        console.warn('⚠️ Smart Pipeline failed:', error);
        retrieval = undefined;
      }
    }
    
    // Final fallback: Traditional pipeline (always available)
    if (!retrieval) {
      console.log('📚 Using traditional pipeline as final fallback...');
      const pipeline = await getRagPipeline();
      retrieval = await pipeline.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
      pipelineUsed = 'traditional';
      console.log(`Traditional pipeline returned ${retrieval.chunks.length} chunks`);
    }
    
    console.log(`📊 Final result: ${retrieval.chunks.length} chunks from ${pipelineUsed} pipeline`);

    if (!useLlm) {
      const { displayCitations, indexMap } = dedupeCitations(retrieval.citations);
      return { 
        answer: `Retrieved ${retrieval.chunks.length} chunks for: ${query.question}`, 
        citations: retrieval.citations,
        displayCitations,
        citationIndexMap: indexMap
      };
    }

    // Build context from chunks
    const contextText = retrieval.chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.title}${chunk.sectionAnchor ? ` (${chunk.sectionAnchor})` : ''}\n${chunk.text}`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a knowledgeable documentation assistant that provides well-structured, helpful responses.',
        'IMPORTANT: Format your response using clear markdown structure with appropriate headings, lists, and code blocks.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Structure your response based on the question type:',
        '- For troubleshooting: Use "## Problem" and "## Solution" sections',
        '- For how-to questions: Use numbered steps with clear headings',
        '- For explanations: Use appropriate headings to break down concepts',
        '- For comparisons: Use tables or structured lists to compare options',
        'Use **bold** for important terms and `code` formatting for technical elements.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order.',
        'Place citations immediately after the sentence they support. Only cite numbers that exist in the provided context.',
        'If a sentence is not directly supported by a specific chunk, omit the citation. Prefer the first clearly relevant chunk when multiple apply.',
        'Use blockquotes (>) for important notes or warnings.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    let answer = await chatCompletion([system, user], { model: query.model });
    // Fallback: ensure at least one bracketed citation exists if we have sources
    if (!/\[(\d+)\]/.test(answer) && retrieval.citations.length > 0) {
      answer = `${answer}\n\nSources: [1]`;
    }
    const { displayCitations, indexMap } = dedupeCitations(retrieval.citations);
    return { answer, citations: retrieval.citations, displayCitations, citationIndexMap: indexMap };

  } catch (err) {
    console.warn('RAG query failed:', err);
    return { 
      answer: `Failed to process query: ${query.question}. Error: ${err instanceof Error ? err.message : 'Unknown error'}`, 
      citations: [] 
    };
  }
}

export async function* ragQueryStream(query: ValidRagQuery): AsyncGenerator<{ type: 'citations' | 'content' | 'done', citations?: any[], content?: string }, void, unknown> {
  const useLlm = (process.env.LLM_BASE_URL || '').length > 0;
  const useRealRAG = process.env.CONFLUENCE_BASE_URL && process.env.CONFLUENCE_USERNAME;
  
  let citations: any[] = [];

  // Use mock citations if Confluence not configured
  if (!useRealRAG) {
    citations = [
      { pageId: '12345', title: 'Getting Started', url: 'https://confluence.local/pages/12345', sectionAnchor: 'introduction', snippet: 'This is mock content for the Getting Started page with helpful information about getting up and running.' },
      { pageId: '67890', title: 'Architecture Overview', url: 'https://confluence.local/pages/67890', sectionAnchor: 'rag-pipeline', snippet: 'Mock content describing the RAG pipeline architecture and how it processes queries.' },
    ];
    
    const { displayCitations, indexMap } = dedupeCitations(citations);
    // Send citations first
    yield { type: 'citations', citations: { original: citations, display: displayCitations, indexMap } } as any;
    
    if (!useLlm) {
      yield { type: 'content', content: `Mock answer for: ${query.question} (Configure LLM_BASE_URL and CONFLUENCE_* env vars for full RAG)` };
      yield { type: 'done' };
      return;
    }

    // Use LLM with mock context
    const contextText = citations
      .map((citation, i) => `[${i + 1}] ${citation.title}${citation.sectionAnchor ? ` (${citation.sectionAnchor})` : ''}\nThis is mock content for the ${citation.title} page.`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a knowledgeable documentation assistant that provides well-structured, helpful responses.',
        'IMPORTANT: Format your response using clear markdown structure with appropriate headings, lists, and code blocks.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Structure your response based on the question type:',
        '- For troubleshooting: Use "## Problem" and "## Solution" sections',
        '- For how-to questions: Use numbered steps with clear headings',
        '- For explanations: Use appropriate headings to break down concepts',
        '- For comparisons: Use tables or structured lists to compare options',
        'Use **bold** for important terms and `code` formatting for technical elements.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order.',
        'Always include bracketed citations immediately after the specific sentence they support. Only cite numbers that exist in the provided context.',
        'Cite ONLY sources that directly support your statements. Limit to at most 3 distinct citations.',
        'End your answer with a final line: "Sources: [n][, [m][, [k]]]" listing ONLY the citations you used.',
        'Use blockquotes (>) for important notes or warnings.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    try {
      for await (const chunk of chatCompletionStream([system, user], { model: query.model })) {
        yield { type: 'content', content: chunk };
      }
      yield { type: 'done' };
    } catch (err) {
      console.warn('LLM streaming call failed:', err);
      yield { type: 'content', content: `Mock answer for: ${query.question} (LLM call failed: ${err instanceof Error ? err.message : 'Unknown error'})` };
      yield { type: 'done' };
    }
    return;
  }

  try {
    // Build filters from query
    const filters: Filters = {
      space: query.space,
      labels: query.labels,
      updatedAfter: query.updatedAfter
    };

    // Optional intent processing to normalize queries and generate fallbacks
    const enableIntent = (process.env.ENABLE_INTENT_PROCESSING || 'true').toLowerCase() !== 'false';
    const minIntentConf = isFinite(Number(process.env.INTENT_CONFIDENCE_THRESHOLD))
      ? Number(process.env.INTENT_CONFIDENCE_THRESHOLD)
      : 0.7;
    const maxFallbacks = Math.max(0, parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10) || 3);
    let queriesToTry: string[] = [query.question];
    let intentCtx: { intent: string; confidence: number; normalizedQuery: string } | undefined;
    if (enableIntent) {
      const intentProcessor = new QueryIntentProcessor();
      const intent = intentProcessor.processQuery(query.question);
      intentCtx = { intent: intent.intent, confidence: intent.confidence, normalizedQuery: intent.normalizedQuery };
      console.log(`Query intent: ${intent.intent} (confidence: ${intent.confidence.toFixed(2)})`);
      console.log(`Normalized variant: "${intent.normalizedQuery}"`);

      const variants: string[] = [];
      if (intent.normalizedQuery && intent.normalizedQuery !== query.question && intent.confidence >= minIntentConf) {
        variants.push(intent.normalizedQuery);
      }
      const fallbacks = intent.fallbackQueries.slice(0, maxFallbacks);
      queriesToTry = [query.question, ...variants, ...fallbacks].filter((v, i, a) => v && a.indexOf(v) === i);
    }

    // Use same pipeline selection logic as non-streaming version
    const useOptimizedPipeline = process.env.USE_OPTIMIZED_PIPELINE === 'true';
    const useSmartFallback = process.env.USE_SMART_PIPELINE !== 'false';
    console.log(`🔍 Streaming pipeline selection: OPTIMIZED=${useOptimizedPipeline}, SMART_FALLBACK=${useSmartFallback}`);
    
    let retrieval: RetrievalResult | undefined;
    let pipelineUsed = 'unknown';
    
    // Primary: Try Optimized Pipeline if enabled
    if (useOptimizedPipeline) {
      try {
        const optimizedPipe = await getOptimizedPipeline();
        retrieval = await optimizedPipe.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
        
        if (retrieval.chunks.length > 0) {
          pipelineUsed = 'optimized';
        } else {
          retrieval = undefined;
        }
      } catch (error) {
        console.warn('OptimizedRAG failed in streaming, falling back:', error);
        retrieval = undefined;
      }
    }
    
    // Fallback: Smart Pipeline if no results from optimized
    if (!retrieval && useSmartFallback) {
      try {
        const smartPipe = await getSmartPipeline();
        retrieval = await smartPipe.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
        
        if (retrieval.chunks.length > 0) {
          pipelineUsed = 'smart';
        } else {
          retrieval = undefined;
        }
      } catch (error) {
        console.warn('Smart Pipeline failed in streaming:', error);
        retrieval = undefined;
      }
    }
    
    // Final fallback: Traditional pipeline
    if (!retrieval) {
      const pipeline = await getRagPipeline();
      retrieval = await pipeline.retrieveForQuery(queriesToTry, filters, query.topK, query.model, query.conversationId, intentCtx);
      pipelineUsed = 'traditional';
    }
    
    console.log(`📊 Streaming result: ${retrieval.chunks.length} chunks from ${pipelineUsed} pipeline`);

    citations = retrieval.citations;
    const { displayCitations, indexMap } = dedupeCitations(citations);

    // Send citations first (include displayCitations and index map for UIs that support it)
    yield { type: 'citations', citations: { original: citations, display: displayCitations, indexMap } } as any;

    if (!useLlm) {
      yield { type: 'content', content: `Retrieved ${retrieval.chunks.length} chunks for: ${query.question}` };
      yield { type: 'done' };
      return;
    }

    // Build context from chunks
    const contextText = retrieval.chunks
      .map((chunk, i) => `[${i + 1}] ${chunk.title}${chunk.sectionAnchor ? ` (${chunk.sectionAnchor})` : ''}\n${chunk.text}`)
      .join('\n\n');

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a knowledgeable documentation assistant that provides well-structured, helpful responses.',
        'IMPORTANT: Format your response using clear markdown structure with appropriate headings, lists, and code blocks.',
        'Answer ONLY using the provided context. If insufficient, say you do not know.',
        'Structure your response based on the question type:',
        '- For troubleshooting: Use "## Problem" and "## Solution" sections',
        '- For how-to questions: Use numbered steps with clear headings',
        '- For explanations: Use appropriate headings to break down concepts',
        '- For comparisons: Use tables or structured lists to compare options',
        'Use **bold** for important terms and `code` formatting for technical elements.',
        'Citations: Use bracketed numbers like [1], [2] that refer to the sources list order.',
        'Place citations immediately after the sentence they support.',
        'Use blockquotes (>) for important notes or warnings.',
        'Do not invent facts or sources.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Context:\n${contextText}\n\nQuestion: ${query.question}`
    };

    try {
      for await (const chunk of chatCompletionStream([system, user], { model: query.model })) {
        yield { type: 'content', content: chunk };
      }
      yield { type: 'done' };
    } catch (err) {
      console.warn('LLM streaming call failed:', err);
      yield { type: 'content', content: `Failed to process query: ${query.question}. Error: ${err instanceof Error ? err.message : 'Unknown error'}` };
      yield { type: 'done' };
    }
  } catch (err) {
    console.warn('RAG query failed:', err);
    yield { type: 'content', content: `Failed to process query: ${query.question}. Error: ${err instanceof Error ? err.message : 'Unknown error'}` };
    yield { type: 'done' };
  }
}
// Consolidate citations by (pageId + url), merging snippets and preserving the
// first occurrence index to keep [n] mapping consistent.
function dedupeCitations(citations: Citation[]): { displayCitations: Citation[]; indexMap: number[] } {
  const keyOf = (c: Citation) => `${c.pageId}|${c.url}`;
  const byKey: Map<string, { citation: Citation; firstIndex: number; snippets: string[] } > = new Map();
  const indexMap: number[] = new Array(citations.length).fill(0);

  for (let i = 0; i < citations.length; i++) {
    const c = citations[i];
    const key = keyOf(c);
    if (!byKey.has(key)) {
      byKey.set(key, { citation: { ...c }, firstIndex: i, snippets: c.snippet ? [c.snippet] : [] });
    } else {
      const entry = byKey.get(key)!;
      // Merge non-critical fields conservatively
      if (!entry.citation.title && c.title) {entry.citation.title = c.title;}
      if (!entry.citation.sectionAnchor && c.sectionAnchor) {entry.citation.sectionAnchor = c.sectionAnchor;}
      if (c.snippet && !entry.snippets.includes(c.snippet)) {entry.snippets.push(c.snippet);}
      entry.firstIndex = Math.min(entry.firstIndex, i);
    }
  }

  const merged: Array<{ citation: Citation; firstIndex: number }> = [];
  const cap = (s: string) => (s.length > 400 ? s.slice(0, 397) + '...' : s);

  for (const entry of byKey.values()) {
    const mergedSnippet = entry.snippets.join('\n...\n');
    if (mergedSnippet) {entry.citation.snippet = cap(mergedSnippet);}
    merged.push({ citation: entry.citation, firstIndex: entry.firstIndex });
  }

  merged.sort((a, b) => a.firstIndex - b.firstIndex);

  // Build index map: original index -> deduped index
  const keyToDisplayIndex = new Map<string, number>();
  merged.forEach((m, idx) => {
    const key = keyOf(m.citation);
    keyToDisplayIndex.set(key, idx);
  });
  citations.forEach((c, i) => {
    indexMap[i] = keyToDisplayIndex.get(keyOf(c)) ?? i;
  });

  return { displayCitations: merged.map(m => m.citation), indexMap };
}
