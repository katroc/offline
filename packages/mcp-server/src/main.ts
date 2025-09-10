import './env.js';
import Fastify from 'fastify';
import { generateRequestId, logRequestStart, logRequestEnd, logError } from './logger.js';
import { validateRagQuery } from './validation.js';
import { ragQuery, ragQueryStream } from './orchestrator.js';
import { chatCompletion, type ChatMessage } from './llm/chat.js';
import { ConfluenceClient } from './sources/confluence.js';
import { SimpleChunker } from './retrieval/chunker.js';
import { LanceDBVectorStore, ChromaVectorStore } from './retrieval/vector-store.js';
import { GoogleEmbedder } from './llm/google-embedder.js';
import { fileURLToPath } from 'url';
import path from 'node:path';
import { CrawlerConfigStore } from './ingest/config-store.js';
import { RateLimiter } from './ingest/utils.js';

const port = Number(process.env.MCP_PORT || 8787);
const host = String(process.env.MCP_HOST || '127.0.0.1');

const app = Fastify({ logger: false });

// Request ID + basic logging hooks
app.addHook('onRequest', async (req, reply) => {
  const startedAt = Date.now();
  // Attach timing to request context
  (req as any).startedAt = startedAt;
  const incoming = req.headers['x-request-id'];
  const reqId = String(incoming || generateRequestId());
  reply.header('x-request-id', reqId);
  (req as any).reqId = reqId;
  logRequestStart({ reqId, method: req.method, url: req.url });
});

app.addHook('onResponse', async (req, reply) => {
  const reqId = (req as any).reqId as string | undefined;
  const startedAt = (req as any).startedAt as number | undefined;
  logRequestEnd({ reqId: reqId || '-', method: req.method, url: req.url, status: reply.statusCode, startedAt: startedAt || Date.now() });
});

// Health
app.get('/health', async () => ({ status: 'ok' }));

// List available LM Studio models
app.get('/models', async (req, reply) => {
  try {
    const baseUrl = process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
    const response = await fetch(`${baseUrl}/v1/models`);
    if (!response.ok) {
      return reply.code(502).send({ error: 'Failed to fetch models from LM Studio' });
    }
    const data = await response.json();
    return reply.send(data);
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(502).send({ error: 'LM Studio not available' });
  }
});

// Chat completions (for title generation and other direct LLM calls)
app.post('/chat/completions', async (req, reply) => {
  try {
    const body = req.body as any;
    const messages: ChatMessage[] = body.messages || [];
    const temperature = body.temperature ?? 0.7;
    const maxTokens = body.max_tokens ?? 512;
    const model = body.model;
    
    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: 'messages array is required' });
    }
    
    const content = await chatCompletion(messages, {
      temperature,
      maxTokens,
      model,
    });
    
    // Return in OpenAI-compatible format
    return reply.send({
      choices: [{
        message: {
          role: 'assistant',
          content
        },
        finish_reason: 'stop',
        index: 0
      }],
      usage: {
        prompt_tokens: 0, // Not tracked
        completion_tokens: 0, // Not tracked
        total_tokens: 0
      }
    });
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(500).send({ error: err instanceof Error ? err.message : 'chat completion failed' });
  }
});

// Direct LLM query (bypass RAG completely)
app.post('/llm/query', async (req, reply) => {
  try {
    const body = req.body as any;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : undefined;
    
    if (!question) {
      return reply.code(400).send({ error: 'question is required' });
    }

    const useLlm = (process.env.LLM_BASE_URL || '').length > 0;
    if (!useLlm) {
      return reply.send({
        answer: `Direct LLM answer for: ${question} (Configure LLM_BASE_URL for actual LLM responses)`,
        citations: [],
        displayCitations: [],
        citationIndexMap: []
      });
    }

    const system: ChatMessage = {
      role: 'system',
      content: [
        'You are a helpful AI assistant with broad knowledge across many topics.',
        'Answer questions directly using your training knowledge.',
        'Format your responses clearly using markdown with appropriate headings, lists, and code blocks.',
        'If you are unsure about something specific, acknowledge the uncertainty.',
        'For technical questions, provide practical examples when helpful.',
        'Use **bold** for emphasis and `code` formatting for technical terms.',
        'Structure your response based on the question type with clear sections when appropriate.'
      ].join(' ')
    };

    const user: ChatMessage = {
      role: 'user',
      content: question
    };

    const answer = await chatCompletion([system, user], { model });
    return reply.send({
      answer,
      citations: [],
      displayCitations: [],
      citationIndexMap: []
    });

  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(500).send({ 
      error: `Failed to process LLM query: ${err instanceof Error ? err.message : 'Unknown error'}` 
    });
  }
});

// RAG query (using our validator + orchestrator stub)
app.post('/rag/query', async (req, reply) => {
  try {
    const result = validateRagQuery(req.body as unknown);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    const { question, space, labels, updatedAfter, topK, model } = result.value;
    const rag = await ragQuery({ question, space, labels, updatedAfter, topK, model });
    return reply.send({ ...rag, meta: { request: { space, labels, updatedAfter, topK, model } } });
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(400).send({ error: 'invalid JSON body' });
  }
});

// RAG streaming query (Server-Sent Events)
app.post('/rag/stream', async (req, reply) => {
  try {
    const result = validateRagQuery(req.body as unknown);
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    const { question, space, labels, updatedAfter, topK, model } = result.value;
    
    // Stream from the real RAG pipeline
    for await (const chunk of ragQueryStream({ question, space, labels, updatedAfter, topK, model })) {
      if (chunk.type === 'citations') {
        // If orchestrator provided both original and display, forward both.
        const payload = typeof (chunk.citations as any)?.original !== 'undefined'
          ? { citations: (chunk.citations as any).original, displayCitations: (chunk.citations as any).display }
          : { citations: chunk.citations };
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'citations', 
          ...payload,
          meta: { request: { space, labels, updatedAfter, topK, model } }
        })}\n\n`);
      } else if (chunk.type === 'content') {
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'content', 
          content: chunk.content 
        })}\n\n`);
      } else if (chunk.type === 'done') {
        reply.raw.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        reply.raw.end();
        break;
      }
    }
    
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(400).send({ error: 'invalid JSON body' });
  }
});

// --- Admin endpoints (minimal) ---
function isAuthorized(req: any): boolean {
  const key = process.env.ADMIN_API_KEY || '';
  // If no key configured, treat as public (optional API key)
  if (!key) return true;
  const hdr = req.headers['x-api-key'] || req.headers['authorization'];
  if (!hdr) return false;
  if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) {
    return hdr.slice(7).trim() === key;
  }
  return hdr === key;
}

app.post('/admin/sync', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });

  const body = (req.body as any) || {};
  let spaces: string[] = [];
  if (Array.isArray(body.spaces) && body.spaces.length > 0) {
    spaces = body.spaces;
  } else {
    const raw = (process.env.CRAWL_SPACES || '').trim();
    if (raw && raw.toLowerCase() !== 'null' && raw.toLowerCase() !== 'undefined') {
      spaces = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
  }

  // Fire-and-forget: run a lightweight in-process batch using the same pipeline pieces
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../../../');

  const confluence = new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
    username: process.env.CONFLUENCE_USERNAME || '',
    apiToken: process.env.CONFLUENCE_API_TOKEN || ''
  });
  const minIntervalMs = Math.max(0, parseInt(String(process.env.CONFLUENCE_MIN_INTERVAL_MS || 0), 10) || 0);
  const rl = new RateLimiter(minIntervalMs);
  if (spaces.length === 0) {
    try {
      spaces = await confluence.listAllSpaceKeys();
    } catch (e) {
      return reply.code(400).send({ error: 'Unable to list spaces and none provided' });
    }
  }
  // Choose vector store based on configuration
  const vectorStoreType = process.env.VECTOR_STORE || 'lancedb';
  let vector: LanceDBVectorStore | ChromaVectorStore;

  if (vectorStoreType.toLowerCase() === 'chroma') {
    vector = new ChromaVectorStore({
      host: process.env.CHROMA_HOST,
      port: process.env.CHROMA_PORT ? parseInt(process.env.CHROMA_PORT, 10) : undefined,
      ssl: process.env.CHROMA_SSL === 'true',
      collectionName: process.env.CHROMA_COLLECTION || 'confluence_chunks',
      auth: process.env.CHROMA_AUTH_PROVIDER && process.env.CHROMA_AUTH_CREDENTIALS ? {
        provider: process.env.CHROMA_AUTH_PROVIDER as 'token' | 'basic',
        credentials: process.env.CHROMA_AUTH_CREDENTIALS
      } : undefined
    });
  } else {
    // Default to LanceDB
    const lanceEnv = process.env.LANCEDB_PATH || './data/lancedb';
    const lanceDbPath = path.isAbsolute(lanceEnv) ? lanceEnv : path.resolve(repoRoot, lanceEnv);
    vector = new LanceDBVectorStore({ dbPath: lanceDbPath, tableName: 'confluence_chunks' });
  }
  try { 
    await vector.initialize(); 
  } catch (error) {
    console.error('Failed to initialize vector store:', error);
    throw error;
  }
  const chunker = new SimpleChunker({ targetChunkSize: 800, overlap: 200, maxChunkSize: 1200 });
  const embedder = new GoogleEmbedder();

  const pageSize = Math.max(1, Math.min(100, Number(body.pageSize ?? process.env.CRAWL_PAGE_SIZE ?? 50)));
  const maxPages = Math.max(1, Number(body.maxPages ?? process.env.CRAWL_MAX_PAGES_PER_TICK ?? 100));

  setTimeout(async () => {
    try {
      for (const space of spaces) {
        let start = 0;
        let processed = 0;
        while (processed < maxPages) {
          await rl.waitTurn();
          const resp = await confluence.listPagesBySpace(space, start, pageSize);
          if (!resp.documents || resp.documents.length === 0) break;
          for (const d of resp.documents) {
            if (processed >= maxPages) break;
            processed++;
            try {
              await rl.waitTurn();
              const doc = await confluence.getDocumentById(d.id);
              const page = { id: doc.id, title: doc.title, spaceKey: doc.spaceKey, version: doc.version, labels: doc.labels, updatedAt: doc.updatedAt, url: doc.url };
              const chunks = await chunker.chunkDocument(page, doc.content);
              if (chunks.length === 0) continue;
              const texts = chunks.map(c => c.text);
              const batchSize = Math.max(1, parseInt(String(process.env.EMBED_BATCH_SIZE || 16), 10) || 16);
              const delayMs = Math.max(0, parseInt(String(process.env.EMBED_DELAY_MS || 0), 10) || 0);
              const vectors: number[][] = [];
              for (let i = 0; i < texts.length; i += batchSize) {
                const slice = texts.slice(i, i + batchSize);
                const res = await embedder.embed(slice);
                vectors.push(...res);
                if (delayMs > 0 && i + batchSize < texts.length) await new Promise(r => setTimeout(r, delayMs));
              }
              for (let i = 0; i < chunks.length; i++) chunks[i].vector = vectors[i];
              await vector.upsertChunks(chunks);
            } catch (e) {
              console.warn('admin sync: failed page', d.id, e);
            }
          }
          start = resp.start + resp.limit;
          if (resp.documents.length < pageSize) break;
        }
      }
      console.log('admin sync: completed');
    } catch (e) {
      console.warn('admin sync: error', e);
    }
  }, 10);

  return reply.send({ ok: true, spaces, pageSize, maxPages });
});

// Get available Confluence spaces (for UI selection)
app.get('/admin/confluence/spaces', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const client = new ConfluenceClient({
      baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
      username: process.env.CONFLUENCE_USERNAME || '',
      apiToken: process.env.CONFLUENCE_API_TOKEN || ''
    });
    const keys = await client.listAllSpaceKeys();
    return reply.send({ spaces: keys });
  } catch (e) {
    return reply.code(502).send({ error: 'failed to list spaces' });
  }
});

// Get crawler config (JSON-backed)
app.get('/admin/crawler/config', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../../../');
  const store = new CrawlerConfigStore(repoRoot);
  try {
    const cfg = await store.load();
    return reply.send(cfg);
  } catch (e) {
    return reply.code(500).send({ error: 'failed to load config' });
  }
});

// Update crawler config (JSON-backed)
app.put('/admin/crawler/config', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../../../');
  const store = new CrawlerConfigStore(repoRoot);
  try {
    const body = (req.body as any) || {};
    const current = await store.load();
    const next = store.validate({
      allSpaces: typeof body.allSpaces === 'boolean' ? body.allSpaces : current.allSpaces,
      spaces: Array.isArray(body.spaces) ? body.spaces : current.spaces,
      pageSize: body.pageSize ?? current.pageSize,
      maxPagesPerTick: body.maxPagesPerTick ?? current.maxPagesPerTick,
      concurrency: body.concurrency ?? current.concurrency,
      cron: body.cron ?? current.cron
    });
    await store.save(next);
    return reply.send(next);
  } catch (e) {
    return reply.code(400).send({ error: 'invalid config' });
  }
});

// RAG Settings - Get current RAG pipeline environment variables
app.get('/admin/rag/config', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const config = {
      // Pipeline Selection
      useOptimizedPipeline: process.env.USE_OPTIMIZED_PIPELINE === 'true',
      useSmartPipeline: process.env.USE_SMART_PIPELINE !== 'false',
      
      // Relevance Settings
      relevanceThreshold: parseFloat(process.env.RELEVANCE_THRESHOLD || '0.05'),
      adaptiveThreshold: process.env.ADAPTIVE_THRESHOLD === 'true',
      
      // Vector Search Settings
      mmrLambda: parseFloat(process.env.MMR_LAMBDA || '0.7'),
      maxVectorCandidates: parseInt(process.env.MAX_VECTOR_CANDIDATES || '50', 10),
      minVectorResults: parseInt(process.env.MIN_VECTOR_RESULTS || '3', 10),
      mmrPoolMultiplier: parseInt(process.env.MMR_POOL_MULTIPLIER || '5', 10),
      
      // Embedding Settings
      embedIncludeTitle: process.env.EMBED_INCLUDE_TITLE !== 'false',
      embedTitleWeight: parseInt(process.env.EMBED_TITLE_WEIGHT || '2', 10),
      embedIncludeLabels: process.env.EMBED_INCLUDE_LABELS === 'true',
      embedIncludeAnchor: process.env.EMBED_INCLUDE_ANCHOR === 'true',
      
      // Query Processing
      enableIntentProcessing: process.env.ENABLE_INTENT_PROCESSING !== 'false',
      maxFallbackQueries: parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10),
      intentConfidenceThreshold: parseFloat(process.env.INTENT_CONFIDENCE_THRESHOLD || '0.7'),
      
      // Advanced Settings
      chunkTtlDays: parseInt(process.env.CHUNK_TTL_DAYS || '7', 10),
      minKeywordScore: parseFloat(process.env.MIN_KEYWORD_SCORE || '0.0'),
      preferLiveSearch: process.env.PREFER_LIVE_SEARCH === 'true'
    };
    return reply.send(config);
  } catch (e) {
    return reply.code(500).send({ error: 'failed to load RAG config' });
  }
});

// RAG Settings - Update RAG pipeline environment variables
app.put('/admin/rag/config', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const body = (req.body as any) || {};
    
    // Update environment variables with validation
    if (typeof body.useOptimizedPipeline === 'boolean') {
      process.env.USE_OPTIMIZED_PIPELINE = String(body.useOptimizedPipeline);
    }
    if (typeof body.useSmartPipeline === 'boolean') {
      process.env.USE_SMART_PIPELINE = String(body.useSmartPipeline);
    }
    
    // Relevance Settings
    if (typeof body.relevanceThreshold === 'number' && body.relevanceThreshold >= 0 && body.relevanceThreshold <= 1) {
      process.env.RELEVANCE_THRESHOLD = String(body.relevanceThreshold);
    }
    if (typeof body.adaptiveThreshold === 'boolean') {
      process.env.ADAPTIVE_THRESHOLD = String(body.adaptiveThreshold);
    }
    
    // Vector Search Settings
    if (typeof body.mmrLambda === 'number' && body.mmrLambda >= 0 && body.mmrLambda <= 1) {
      process.env.MMR_LAMBDA = String(body.mmrLambda);
    }
    if (typeof body.maxVectorCandidates === 'number' && body.maxVectorCandidates >= 1 && body.maxVectorCandidates <= 200) {
      process.env.MAX_VECTOR_CANDIDATES = String(body.maxVectorCandidates);
    }
    if (typeof body.minVectorResults === 'number' && body.minVectorResults >= 1 && body.minVectorResults <= 50) {
      process.env.MIN_VECTOR_RESULTS = String(body.minVectorResults);
    }
    if (typeof body.mmrPoolMultiplier === 'number' && body.mmrPoolMultiplier >= 1 && body.mmrPoolMultiplier <= 20) {
      process.env.MMR_POOL_MULTIPLIER = String(body.mmrPoolMultiplier);
    }
    
    // Embedding Settings
    if (typeof body.embedIncludeTitle === 'boolean') {
      process.env.EMBED_INCLUDE_TITLE = String(body.embedIncludeTitle);
    }
    if (typeof body.embedTitleWeight === 'number' && body.embedTitleWeight >= 1 && body.embedTitleWeight <= 10) {
      process.env.EMBED_TITLE_WEIGHT = String(body.embedTitleWeight);
    }
    if (typeof body.embedIncludeLabels === 'boolean') {
      process.env.EMBED_INCLUDE_LABELS = String(body.embedIncludeLabels);
    }
    if (typeof body.embedIncludeAnchor === 'boolean') {
      process.env.EMBED_INCLUDE_ANCHOR = String(body.embedIncludeAnchor);
    }
    
    // Query Processing
    if (typeof body.enableIntentProcessing === 'boolean') {
      process.env.ENABLE_INTENT_PROCESSING = String(body.enableIntentProcessing);
    }
    if (typeof body.maxFallbackQueries === 'number' && body.maxFallbackQueries >= 1 && body.maxFallbackQueries <= 10) {
      process.env.MAX_FALLBACK_QUERIES = String(body.maxFallbackQueries);
    }
    if (typeof body.intentConfidenceThreshold === 'number' && body.intentConfidenceThreshold >= 0 && body.intentConfidenceThreshold <= 1) {
      process.env.INTENT_CONFIDENCE_THRESHOLD = String(body.intentConfidenceThreshold);
    }
    
    // Advanced Settings
    if (typeof body.chunkTtlDays === 'number' && body.chunkTtlDays >= 0) {
      process.env.CHUNK_TTL_DAYS = String(body.chunkTtlDays);
    }
    if (typeof body.minKeywordScore === 'number' && body.minKeywordScore >= 0 && body.minKeywordScore <= 1) {
      process.env.MIN_KEYWORD_SCORE = String(body.minKeywordScore);
    }
    if (typeof body.preferLiveSearch === 'boolean') {
      process.env.PREFER_LIVE_SEARCH = String(body.preferLiveSearch);
    }
    
    // Return updated config
    const updatedConfig = {
      useOptimizedPipeline: process.env.USE_OPTIMIZED_PIPELINE === 'true',
      useSmartPipeline: process.env.USE_SMART_PIPELINE !== 'false',
      relevanceThreshold: parseFloat(process.env.RELEVANCE_THRESHOLD || '0.05'),
      adaptiveThreshold: process.env.ADAPTIVE_THRESHOLD === 'true',
      mmrLambda: parseFloat(process.env.MMR_LAMBDA || '0.7'),
      maxVectorCandidates: parseInt(process.env.MAX_VECTOR_CANDIDATES || '50', 10),
      minVectorResults: parseInt(process.env.MIN_VECTOR_RESULTS || '3', 10),
      mmrPoolMultiplier: parseInt(process.env.MMR_POOL_MULTIPLIER || '5', 10),
      embedIncludeTitle: process.env.EMBED_INCLUDE_TITLE !== 'false',
      embedTitleWeight: parseInt(process.env.EMBED_TITLE_WEIGHT || '2', 10),
      embedIncludeLabels: process.env.EMBED_INCLUDE_LABELS === 'true',
      embedIncludeAnchor: process.env.EMBED_INCLUDE_ANCHOR === 'true',
      enableIntentProcessing: process.env.ENABLE_INTENT_PROCESSING !== 'false',
      maxFallbackQueries: parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10),
      intentConfidenceThreshold: parseFloat(process.env.INTENT_CONFIDENCE_THRESHOLD || '0.7'),
      chunkTtlDays: parseInt(process.env.CHUNK_TTL_DAYS || '7', 10),
      minKeywordScore: parseFloat(process.env.MIN_KEYWORD_SCORE || '0.0'),
      preferLiveSearch: process.env.PREFER_LIVE_SEARCH === 'true'
    };
    
    return reply.send(updatedConfig);
  } catch (e) {
    return reply.code(400).send({ error: 'invalid RAG config' });
  }
});

// Vector store stats (diagnostics): row count and recent indexed_at
app.get('/admin/vector/stats', async (req, reply) => {
  if (!isAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, '../../../');
    
    // Choose vector store based on configuration
    const vectorStoreType = process.env.VECTOR_STORE || 'lancedb';
    let vector: LanceDBVectorStore | ChromaVectorStore;
    let dbInfo: any = {};

    if (vectorStoreType.toLowerCase() === 'chroma') {
      vector = new ChromaVectorStore({
        host: process.env.CHROMA_HOST,
        port: process.env.CHROMA_PORT ? parseInt(process.env.CHROMA_PORT, 10) : undefined,
        ssl: process.env.CHROMA_SSL === 'true',
        collectionName: process.env.CHROMA_COLLECTION || 'confluence_chunks',
        auth: process.env.CHROMA_AUTH_PROVIDER && process.env.CHROMA_AUTH_CREDENTIALS ? {
          provider: process.env.CHROMA_AUTH_PROVIDER as 'token' | 'basic',
          credentials: process.env.CHROMA_AUTH_CREDENTIALS
        } : undefined
      });
      dbInfo = { 
        type: 'chroma', 
        collection: process.env.CHROMA_COLLECTION || 'confluence_chunks',
        host: process.env.CHROMA_HOST || 'localhost',
        port: process.env.CHROMA_PORT || 8000 
      };
    } else {
      const lanceEnv = process.env.LANCEDB_PATH || './data/lancedb';
      const lanceDbPath = path.isAbsolute(lanceEnv) ? lanceEnv : path.resolve(repoRoot, lanceEnv);
      vector = new LanceDBVectorStore({ dbPath: lanceDbPath, tableName: 'confluence_chunks' });
      dbInfo = { type: 'lancedb', table: 'confluence_chunks', dbPath: lanceDbPath };
    }

    await vector.initialize();
    const stats = await (vector as any).getStats?.(5);
    return reply.send({ ok: true, ...dbInfo, stats: stats || null });
  } catch (e) {
    return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : 'failed to read stats' });
  }
});


// Default route (must be last!)
app.all('/*', async (req) => ({ name: 'mcp-server', message: 'scaffold running', path: req.url, method: req.method }));

app.listen({ port, host }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`MCP server (Fastify) listening on ${host}:${port}`);
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Server failed to start', err);
  process.exit(1);
});
