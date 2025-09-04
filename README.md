# Air‑Gapped Confluence AI Assistant

This repo is a monorepo (pnpm workspaces) for an air‑gapped Confluence QA assistant with a Node/TS MCP server, a React UI, Ollama for chat/embeddings, and LanceDB for retrieval.

## Quick Start (scaffold)

- Tooling: Node 20+, pnpm 9+
- Configure env: copy `.env.example` to `.env` and adjust values
- Workspaces: `packages/mcp-server`, `packages/web-ui`, `packages/shared`

Commands (placeholders until deps are staged):
- `pnpm typecheck` — runs TypeScript checks across packages
- `pnpm build` — builds all packages
- `pnpm dev` — runs each package’s dev script in parallel

## Air‑Gapped Notes

- Use `.npmrc` to point to your internal registry and cache.
- Preload Ollama models (`OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`).
- LanceDB path defaults to `./data/lancedb`.

See `TODO.md` for detailed milestones and module tasks.

