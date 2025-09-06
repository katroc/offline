# Cabin Web UI

Vite + React + TypeScript frontend for Cabin. Provides chat UI with streaming answers, citations panel, conversation history, export (Markdown/JSON), model selection, and basic settings.

Scripts
- `pnpm -F @app/web-ui dev` — start Vite dev server (defaults to port 3000)
- `pnpm -F @app/web-ui build` — typecheck and build
- `pnpm -F @app/web-ui preview` — preview production build

Dev proxy
- The dev server proxies API routes to MCP at `http://localhost:8787`:
  - `/health`, `/models`, `/chat`, `/rag`
- Configure in `vite.config.ts` if MCP runs elsewhere.

Features
- Streaming assistant responses with incremental rendering
- Citations with titles, anchors, and snippets
- Multiple conversations, rename/pin/delete, auto-title generation
- Export a conversation as Markdown or JSON
- Light/dark theme toggle

Notes
- The UI expects the MCP server to be reachable at the same origin (or via the dev proxy in development).
- If MCP lacks Confluence and/or LLM config, it serves mock citations and stub answers for UI development.
