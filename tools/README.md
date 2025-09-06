# Tools

Utility scripts and helpers for Cabin.

Ingest Confluence (offline-friendly)
- `tools/ingest-confluence.mjs` fetches pages from a Confluence instance and ingests them into the MCP server without the server needing egress.
- Usage:
  - `node tools/ingest-confluence.mjs --space KEY [--space KEY2] --pageSize 50 --maxPages 2 \
     --server http://127.0.0.1:8787 --base https://cwiki.apache.org/confluence --user USER --token TOKEN`
- Sends payloads to `POST /admin/ingest`.

Ollama model preload
- `scripts/preload-models.sh` pulls and verifies LLMs for Cabin deployment.
- Exports/imports are documented in the script footer.
