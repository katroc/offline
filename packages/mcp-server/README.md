# Cabin MCP Server

Fastify-based Node/TypeScript server that powers Cabin’s retrieval and chat. It exposes health, model listing, OpenAI-compatible chat, RAG (sync + SSE), and admin ingestion/sync endpoints.

Overview
- Framework: Fastify
- LLM: OpenAI-compatible API (LM Studio or Ollama with compatibility)
- Retrieval: Smart pipeline with LLM ranking + chunking; LanceDB when available (mock fallback)
- Confluence: Live search/crawl via REST; can ingest pre-fetched pages

Requirements
- Node 20+
- Build artifacts present in `dist/` (run from repo root: `pnpm build`)

Run
- Env: copy `.env.example` to `.env` at repo root and adjust
- Start: `pnpm -F @app/mcp-server start`
- Dev (uses built files): `pnpm -F @app/mcp-server dev`

Environment
- `MCP_PORT` / `MCP_HOST` — bind address (default `8787` / `127.0.0.1`)
- `LLM_BASE_URL` — OpenAI-compatible base URL (e.g., `http://127.0.0.1:1234`)
- `LLM_CHAT_MODEL` — model id for chat
- `REQUEST_TIMEOUT_MS` — outbound timeout (default 15000)
- `CONFLUENCE_BASE_URL`, `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN` — enable live Confluence
- `LANCEDB_PATH` — path to LanceDB (default `./data/lancedb`)
- `USE_REAL_VECTORDB` — `false` to force mock store
- `USE_SMART_PIPELINE` — `false` to use traditional pipeline
- `PREFER_LIVE_SEARCH` — `true` to prefer live search over local store

Endpoints
- `GET /health` — server health
- `GET /models` — forwards to `${LLM_BASE_URL}/v1/models`
- `POST /chat/completions` — OpenAI-compatible chat wrapper
- `POST /rag/query` — synchronous RAG; body `{ question, space?, labels?, updatedAfter?, topK?, model? }`
- `POST /rag/stream` — SSE RAG stream; yields `citations`, then `content`, then `done`
- `POST /admin/sync` — crawl Confluence spaces into local store; body `{ spaces?: string[], updatedAfter?, maxPages?, pageSize? }`
- `POST /admin/ingest` — ingest array of documents or Confluence API results; body `{ documents: DocumentSource[] }` or `{ confluence: { results: ConfluenceApiPage[] } }`

Notes

- Citations are now 1:1 with the retrieved chunks and preserve the exact order used to build the LLM context. This ensures that bracketed references like `[1]` in the answer map directly to `citations[0]`, `[2]` → `citations[1]`, etc. Each citation also includes a short `snippet` from the underlying chunk for better attribution.
- Responses also include optional `displayCitations` (deduped by `pageId+url`, with merged snippets) and an `citationIndexMap` mapping from original citation indices to their deduped positions. Streaming `citations` events include `{ citations, displayCitations }`.

Quick curl
```
curl -s http://127.0.0.1:8787/health

curl -s http://127.0.0.1:8787/models

curl -s -X POST http://127.0.0.1:8787/rag/query \
  -H 'content-type: application/json' \
  -d '{"question":"How do I deploy?","space":"ENG","topK":5}'

curl -N -X POST http://127.0.0.1:8787/rag/stream \
  -H 'content-type: application/json' \
  -d '{"question":"Explain the RAG pipeline"}'
```

Sources
- Main: `src/main.ts`
- Orchestrator: `src/orchestrator.ts`
- Retrieval: `src/retrieval/*`
- Confluence client/crawler: `src/sources/*`
