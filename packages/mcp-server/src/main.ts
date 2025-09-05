import './env.js';
import Fastify from 'fastify';
import { generateRequestId, logRequestStart, logRequestEnd, logError } from './logger.js';
import { validateRagQuery } from './validation.js';
import { ragQuery, syncConfluence, ingestDocuments, mapConfluenceApiPagesToDocuments } from './orchestrator.js';
import { chatCompletion } from './llm/chat.js';

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

// General chat (no RAG) for ad-hoc questions
app.post('/chat', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    const question: string = typeof body.question === 'string' ? body.question : '';
    const model: string | undefined = typeof body.model === 'string' ? body.model : undefined;
    if (!question) return reply.code(400).send({ error: 'question is required' });
    const system = 'You are a concise, helpful assistant. Answer accurately and clearly.';
    const answer = await chatCompletion([
      { role: 'system', content: system },
      { role: 'user', content: question },
    ], { model });
    return reply.send({ answer, citations: [] });
  } catch (err) {
    const reqId = (req as any).reqId as string | undefined;
    logError({ reqId, method: req.method, url: req.url, err });
    return reply.code(502).send({ error: err instanceof Error ? err.message : 'chat failed' });
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

// Default route
app.all('/*', async (req) => ({ name: 'mcp-server', message: 'scaffold running', path: req.url, method: req.method }));

app.listen({ port, host }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`MCP server (Fastify) listening on ${host}:${port}`);
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Server failed to start', err);
  process.exit(1);
});
