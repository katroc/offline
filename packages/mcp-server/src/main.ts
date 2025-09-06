import './env.js';
import Fastify from 'fastify';
import { generateRequestId, logRequestStart, logRequestEnd, logError } from './logger.js';
import { validateRagQuery } from './validation.js';
import { ragQuery, ragQueryStream, syncConfluence, ingestDocuments, mapConfluenceApiPagesToDocuments } from './orchestrator.js';
import { chatCompletion, type ChatMessage } from './llm/chat.js';

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
        reply.raw.write(`data: ${JSON.stringify({ 
          type: 'citations', 
          citations: chunk.citations,
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

// Admin: trigger Confluence sync (no CQL; paginates content)
app.post('/admin/sync', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    const spaces: string[] | undefined = Array.isArray(body.spaces) ? body.spaces : undefined;
    const updatedAfter: string | undefined = typeof body.updatedAfter === 'string' ? body.updatedAfter : undefined;
    const maxPages: number | undefined = typeof body.maxPages === 'number' ? body.maxPages : undefined;
    const pageSize: number | undefined = typeof body.pageSize === 'number' ? body.pageSize : undefined;

    const result = await syncConfluence({ spaces, updatedAfter, maxPages, pageSize });
    return reply.send({ ok: true, ...result });
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'sync failed' });
  }
});

// Admin: ingest pre-fetched documents (bypass network restrictions)
// Accepts either:
// 1) { documents: DocumentSource[] }
// 2) { confluence: { results: ConfluenceApiPage[] } } (subset of fields)
app.post('/admin/ingest', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    let docs: any[] | undefined = undefined;

    if (Array.isArray(body.documents)) {
      docs = body.documents;
    } else if (body.confluence && Array.isArray(body.confluence.results)) {
      docs = mapConfluenceApiPagesToDocuments(body.confluence.results);
    }

    if (!docs || docs.length === 0) {
      return reply.code(400).send({ ok: false, error: 'Provide documents[] or confluence.results[]' });
    }

    const res = await ingestDocuments(docs);
    return reply.send({ ok: true, ...res });
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(400).send({ ok: false, error: err instanceof Error ? err.message : 'ingest failed' });
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
