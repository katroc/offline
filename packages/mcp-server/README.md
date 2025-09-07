# Cabin MCP Server

Fastify-based Node/TypeScript server that powers Cabin’s retrieval and chat. It exposes health, model listing, OpenAI-compatible chat, RAG (sync + SSE), and admin ingestion/sync endpoints.

Overview
- Framework: Fastify
- LLM: OpenAI-compatible API (LM Studio or Ollama with compatibility)
- Retrieval: Default pipeline with Google embeddings + vector search; Smart pipeline with LLM ranking + chunking; LanceDB vector storage (mock fallback)
- Confluence: Live search/crawl via REST; can ingest pre-fetched pages

Requirements
- Node 20+
- Build artifacts present in `dist/` (run from repo root: `pnpm build`)

Run
- Env: copy `.env.example` to `.env` at repo root and adjust
- Start: `pnpm -F @app/mcp-server start`
- Dev (uses built files): `pnpm -F @app/mcp-server dev`
- All services: `pnpm dev` (runs mcp-server, web-ui in parallel)
- Ingest (background crawl): `pnpm -F @app/mcp-server ingest` (runs one tick using `CRAWL_SPACES`)

Environment
- `MCP_PORT` / `MCP_HOST` — bind address (default `8787` / `127.0.0.1`)
- `LLM_BASE_URL` — OpenAI-compatible base URL (e.g., `http://127.0.0.1:1234`)
- `LLM_CHAT_MODEL` — model id for chat completions
- `LLM_EMBED_MODEL` — model id for embeddings (e.g., `text-embedding-embeddinggemma-300m-qat`)
- `REQUEST_TIMEOUT_MS` — outbound timeout (default 15000)
- `CONFLUENCE_BASE_URL`, `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN` — enable live Confluence
- `LANCEDB_PATH` — path to LanceDB (default `./lancedb`)
- `USE_REAL_VECTORDB` — `true` to use LanceDB vector storage, `false` for mock store
- `USE_SMART_PIPELINE` — `false` to use default vector pipeline, `true` for LLM-based pipeline
- `PREFER_LIVE_SEARCH` — `true` to prefer live search over local store
- `RELEVANCE_THRESHOLD` — minimum similarity score for vector results (default `0.5`)
- `MIN_VECTOR_RESULTS` — minimum number of vector candidates to fetch before MMR (default `3`)
- `ADAPTIVE_THRESHOLD` — `true` to adapt threshold to `max(RELEVANCE_THRESHOLD, 0.6 * maxScore)` (default `false`)
- `MIN_KEYWORD_SCORE` — optional lexical floor [0..1] to filter off-topic vector hits before MMR reordering (default `0.0`)
- `ALLOW_GENERAL_KNOWLEDGE` — `false` to restrict to indexed knowledge only
- `CHUNK_TTL_DAYS` — TTL in days for vector-store chunks (default `7`). Chunks older than this are filtered from vector results; stale pages are lazily re-indexed in the background.
- `ENABLE_INTENT_PROCESSING` — normalize queries and try fallbacks by detected intent (default `true`)
- `INTENT_CONFIDENCE_THRESHOLD` — confidence needed to prefer normalized over original (default `0.7`)
- `MAX_FALLBACK_QUERIES` — max number of alternate query variants to attempt (default `3`)

Vector (LanceDB) tuning
- `LANCEDB_USE_HNSW` — attempt HNSW index creation (fallback to IVF_PQ)
- `LANCEDB_METRIC` — `cosine` (default)
- `LANCEDB_HNSW_M`, `LANCEDB_HNSW_EF_CONSTRUCTION` — HNSW build params
- `LANCEDB_EF_SEARCH`, `LANCEDB_NPROBES`, `LANCEDB_REFINE_FACTOR` — query-time ANN tweaks (best-effort)
- `MAX_VECTOR_CANDIDATES` — cap for candidate pool before MMR (default `50`)
- `MMR_LAMBDA` — relevance vs. diversity balance [0..1] (default `0.7`)
- `MMR_POOL_MULTIPLIER` — expands pool size before MMR (default `10`)
- `EMBED_INCLUDE_TITLE`, `EMBED_TITLE_WEIGHT` — include and weight titles in chunk embeddings (defaults `true`, `2`)
- `EMBED_INCLUDE_LABELS`, `EMBED_INCLUDE_ANCHOR` — include labels/section anchors in embeddings

Endpoints
- `GET /health` — server health
- `GET /models` — forwards to `${LLM_BASE_URL}/v1/models`
- `POST /chat/completions` — OpenAI-compatible chat wrapper
- `POST /rag/query` — synchronous RAG; body `{ query, conversationId?, space?, labels?, updatedAfter?, topK?, model? }`
- `POST /rag/stream` — SSE RAG stream; yields `citations`, then `content`, then `done`
- `POST /admin/sync` — crawl Confluence spaces into local store; body `{ spaces?: string[], updatedAfter?, maxPages?, pageSize? }`
- `POST /admin/ingest` — ingest array of documents or Confluence API results; body `{ documents: DocumentSource[] }` or `{ confluence: { results: ConfluenceApiPage[] } }`

Admin
- Protect admin endpoints with `x-api-key: ${ADMIN_API_KEY}` or `Authorization: Bearer ${ADMIN_API_KEY}`.
- Background ingestion can run as a separate process via `pnpm -F @app/mcp-server ingest`. Configure `CRAWL_SPACES`, `CRAWL_PAGE_SIZE`, `CRAWL_MAX_PAGES_PER_TICK`, and `CRAWL_CONCURRENCY`.

Notes

- Citations are now 1:1 with the retrieved chunks and preserve the exact order used to build the LLM context. This ensures that bracketed references like `[1]` in the answer map directly to `citations[0]`, `[2]` → `citations[1]`, etc. Each citation also includes a short `snippet` from the underlying chunk for better attribution.
- Responses also include optional `displayCitations` (deduped by `pageId+url`, with merged snippets) and an `citationIndexMap` mapping from original citation indices to their deduped positions. Streaming `citations` events include `{ citations, displayCitations }`.

Quick curl
```
curl -s http://127.0.0.1:8787/health

curl -s http://127.0.0.1:8787/models

curl -s -X POST http://127.0.0.1:8787/rag/query \
  -H 'content-type: application/json' \
  -d '{"query":"How do I deploy?","space":"ENG","topK":5}'

curl -N -X POST http://127.0.0.1:8787/rag/stream \
  -H 'content-type: application/json' \
  -d '{"query":"Explain the RAG pipeline"}'
```

Sources
- Main: `src/main.ts`
- Orchestrator: `src/orchestrator.ts`
- Retrieval: `src/retrieval/*`
- Confluence client/crawler: `src/sources/*`
