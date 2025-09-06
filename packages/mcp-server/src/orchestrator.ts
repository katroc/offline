import type { RagResponse, Filters } from '@app/shared';
import type { ValidRagQuery } from './validation.js';
import { chatCompletion, chatCompletionStream, type ChatMessage } from './llm/chat.js';
import { ConfluenceClient } from './sources/confluence.js';
import { LocalDocStore } from './store/local-doc-store.js';
import { MockVectorStore, LanceDBVectorStore } from './retrieval/vector-store.js';
import { SimpleChunker } from './retrieval/chunker.js';
import { DefaultRAGPipeline } from './retrieval/pipeline.js';
import { SmartRAGPipeline } from './retrieval/smart-pipeline.js';

// Singleton instances (in production, these would be properly managed)
let ragPipeline: DefaultRAGPipeline | null = null;
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
      const answer = await chatCompletion([system, user], { model: query.model });
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

    // Use Smart Pipeline by default, fall back to traditional pipeline if needed
    const useSmartPipeline = process.env.USE_SMART_PIPELINE !== 'false'; // Default to true
    
    let retrieval;
    if (useSmartPipeline) {
      console.log('Using Smart Pipeline with LLM document analysis');
      const smartPipe = await getSmartPipeline();
      retrieval = await smartPipe.retrieveForQuery(query.question, filters, query.topK, query.model);
    } else {
      console.log('Using traditional pipeline');
      const pipeline = await getRagPipeline();
      retrieval = await pipeline.retrieveForQuery(query.question, filters, query.topK, query.model);
    }

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

    const answer = await chatCompletion([system, user], { model: query.model });
    return { answer, citations: retrieval.citations };

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
    
    // Send citations first
    yield { type: 'citations', citations };
    
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

    // Use Smart Pipeline by default, fall back to traditional pipeline if needed
    const useSmartPipeline = process.env.USE_SMART_PIPELINE !== 'false'; // Default to true
    
    let retrieval;
    if (useSmartPipeline) {
      console.log('Using Smart Pipeline with LLM document analysis');
      const smartPipe = await getSmartPipeline();
      retrieval = await smartPipe.retrieveForQuery(query.question, filters, query.topK, query.model);
    } else {
      console.log('Using traditional pipeline');
      const pipeline = await getRagPipeline();
      retrieval = await pipeline.retrieveForQuery(query.question, filters, query.topK, query.model);
    }

    citations = retrieval.citations;

    // Send citations first
    yield { type: 'citations', citations };

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

