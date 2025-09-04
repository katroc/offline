#!/usr/bin/env node
// Lightweight CLI: fetch Confluence content and ingest into local MCP server
// Usage:
//   node tools/ingest-confluence.mjs --space MAVEN --pageSize 25 --maxPages 2 \
//     --server http://127.0.0.1:8787 \
//     --base https://cwiki.apache.org/confluence --user public --token public

const defaults = {
  server: process.env.MCP_SERVER_URL || 'http://127.0.0.1:8787',
  base: process.env.CONFLUENCE_BASE_URL || 'https://cwiki.apache.org/confluence',
  user: process.env.CONFLUENCE_USERNAME || 'public',
  token: process.env.CONFLUENCE_API_TOKEN || 'public',
  pageSize: 50,
  maxPages: 1,
};

function parseArgs(argv) {
  const args = { ...defaults, spaces: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    const need = (v) => {
      if (!next) throw new Error(`Missing value for ${a}`);
      i++; return next;
    };
    if (a === '--space' || a === '-s') args.spaces.push(need(next));
    else if (a === '--server') args.server = need(next);
    else if (a === '--base') args.base = need(next);
    else if (a === '--user') args.user = need(next);
    else if (a === '--token') args.token = need(next);
    else if (a === '--pageSize') args.pageSize = Number(need(next));
    else if (a === '--maxPages') args.maxPages = Number(need(next));
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (args.spaces.length === 0 && !args.help) {
    throw new Error('Provide at least one --space');
  }
  return args;
}

function joinUrl(base, path) {
  if (base.endsWith('/') && path.startsWith('/')) return base.slice(0, -1) + path;
  if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
  return base + path;
}

async function fetchJson(url, { user, token, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Accept': 'application/json', 'User-Agent': 'offline-mcp-ingest/0.1' };
    if (user && token && user !== 'public' && token !== 'public') {
      const auth = Buffer.from(`${user}:${token}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function listPagesBySpace({ base, spaceKey, start = 0, limit = 50, user, token }) {
  const params = new URLSearchParams({ type: 'page', spaceKey, start: String(start), limit: String(Math.min(limit, 100)), expand: 'body.storage,version,metadata.labels,space' });
  const url = joinUrl(base, `/rest/api/content?${params}`);
  return await fetchJson(url, { user, token });
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node tools/ingest-confluence.mjs --space KEY [--space KEY2] [--pageSize 50] [--maxPages 2] [--server http://127.0.0.1:8787] [--base URL] [--user USER] [--token TOKEN]`);
    process.exit(0);
  }

  const allResults = [];
  for (const spaceKey of args.spaces) {
    let start = 0, pages = 0;
    console.error(`Fetching space ${spaceKey} from ${args.base} (pageSize=${args.pageSize}, maxPages=${args.maxPages})`);
    while (pages < args.maxPages) {
      const data = await listPagesBySpace({ base: args.base, spaceKey, start, limit: args.pageSize, user: args.user, token: args.token });
      const items = Array.isArray(data.results) ? data.results : [];
      allResults.push(...items);
      pages++;
      if (items.length < args.pageSize) break;
      start += args.pageSize;
    }
  }

  console.error(`Collected ${allResults.length} pages. Ingesting to ${args.server} ...`);
  const ingestRes = await fetch(joinUrl(args.server, '/admin/ingest'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confluence: { results: allResults } })
  });
  const text = await ingestRes.text();
  if (!ingestRes.ok) {
    console.error('Ingest failed:', text);
    process.exit(1);
  }
  console.log(text);
}

run().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });

