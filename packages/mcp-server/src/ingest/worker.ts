import '../env.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ConfluenceClient } from '../sources/confluence.js';
import { SimpleChunker } from '../retrieval/chunker.js';
import { LanceDBVectorStore } from '../retrieval/vector-store.js';
import { GoogleEmbedder } from '../llm/google-embedder.js';
import { JsonStateStore } from './state.js';
import { CrawlerConfigStore } from './config-store.js';
import { normalizeHtml, sha256, Semaphore, RateLimiter } from './utils.js';

type CrawlConfig = {
  spaces: string[];
  pageSize: number;
  maxPagesPerTick: number;
  concurrency: number;
  updatedAfter?: string;
};

async function getRepoRoot(): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '../../../');
}

async function main() {
  const repoRoot = await getRepoRoot();

  // Services
  const confluence = new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
    username: process.env.CONFLUENCE_USERNAME || '',
    apiToken: process.env.CONFLUENCE_API_TOKEN || ''
  });

  // Load JSON config (UI-managed) with env fallbacks
  const cfgStore = new CrawlerConfigStore(repoRoot);
  const uiCfg = await cfgStore.load();

  // Env overrides for backwards compatibility
  const envSpacesRaw = (process.env.CRAWL_SPACES || '').trim();
  let spaces: string[] | null = null;
  let allSpaces = uiCfg.allSpaces;
  if (envSpacesRaw) {
    if (envSpacesRaw.toLowerCase() === 'null' || envSpacesRaw.toLowerCase() === 'undefined') {
      allSpaces = true;
    } else {
      spaces = envSpacesRaw.split(',').map(s => s.trim()).filter(Boolean);
      allSpaces = false;
    }
  }
  if (spaces === null) spaces = uiCfg.spaces;

  if (allSpaces) {
    try {
      spaces = await confluence.listAllSpaceKeys();
      console.log(`Discovered ${spaces.length} spaces to crawl`);
    } catch (e) {
      console.warn('Failed to list spaces and no explicit spaces configured. Exiting.', e);
      process.exit(0);
    }
  }

  const cfg: CrawlConfig = {
    spaces: spaces,
    pageSize: Math.max(1, Math.min(100, parseInt(String(process.env.CRAWL_PAGE_SIZE || uiCfg.pageSize), 10) || uiCfg.pageSize)),
    maxPagesPerTick: Math.max(1, parseInt(String(process.env.CRAWL_MAX_PAGES_PER_TICK || uiCfg.maxPagesPerTick), 10) || uiCfg.maxPagesPerTick),
    concurrency: Math.max(1, parseInt(String(process.env.CRAWL_CONCURRENCY || uiCfg.concurrency), 10) || uiCfg.concurrency),
    updatedAfter: process.env.UPDATED_AFTER || undefined
  };

  const state = new JsonStateStore(repoRoot);
  await state.load();

  const lanceEnv = process.env.LANCEDB_PATH || './data/lancedb';
  const lanceDbPath = path.isAbsolute(lanceEnv) ? lanceEnv : path.resolve(repoRoot, lanceEnv);
  const vector = new LanceDBVectorStore({ dbPath: lanceDbPath, tableName: 'confluence_chunks' });
  await vector.initialize();

  const chunker = new SimpleChunker({ targetChunkSize: 800, overlap: 200, maxChunkSize: 1200 });
  const embedder = new GoogleEmbedder();

  console.log('Ingest worker starting with config:', cfg);
  const minIntervalMs = Math.max(0, parseInt(String(process.env.CONFLUENCE_MIN_INTERVAL_MS || 0), 10) || 0);
  const rl = new RateLimiter(minIntervalMs);

  for (const space of cfg.spaces) {
    let start = 0;
    let processed = 0;
    const limit = cfg.pageSize;
    const sem = new Semaphore(cfg.concurrency);
    const tasks: Array<Promise<void>> = [];

    while (processed < cfg.maxPagesPerTick) {
      await rl.waitTurn();
      const resp = await confluence.listPagesBySpace(space, start, limit);
      if (!resp.documents || resp.documents.length === 0) break;

      for (const doc of resp.documents) {
        if (processed >= cfg.maxPagesPerTick) break;
        processed++;

        const release = await sem.acquire();
        const p = indexOne(doc.id, state, confluence, chunker, embedder, vector, rl)
          .catch(err => {
            console.warn('Index failed for page', doc.id, err);
          })
          .finally(release);
        tasks.push(p);
      }

      start = resp.start + resp.limit;
      if (resp.documents.length < limit) break; // no more pages
    }

    await Promise.allSettled(tasks);
    console.log(`Space ${space}: processed ${processed} pages this tick`);
  }

  await state.persist();
  console.log('Ingest worker: done');
}

async function indexOne(
  pageId: string,
  state: JsonStateStore,
  confluence: ConfluenceClient,
  chunker: SimpleChunker,
  embedder: GoogleEmbedder,
  vector: LanceDBVectorStore
  ,
  rl: RateLimiter
): Promise<void> {
  // Fetch full document
  await rl.waitTurn();
  const doc = await confluence.getDocumentById(pageId);
  const normalized = normalizeHtml(doc.content);
  const hash = sha256(normalized);
  const current = state.get(doc.id);

  if (current && current.version === doc.version && current.contentHash === hash) {
    return; // up-to-date
  }

  const page = {
    id: doc.id,
    title: doc.title,
    spaceKey: doc.spaceKey,
    version: doc.version,
    labels: doc.labels,
    updatedAt: doc.updatedAt,
    url: doc.url
  };

  const chunks = await chunker.chunkDocument(page, doc.content);
  if (chunks.length === 0) return;

  // Embed
  // Embed with batching and pacing
  const allTexts = chunks.map(c => c.text);
  const batchSize = Math.max(1, parseInt(String(process.env.EMBED_BATCH_SIZE || 16), 10) || 16);
  const delayMs = Math.max(0, parseInt(String(process.env.EMBED_DELAY_MS || 0), 10) || 0);
  const vectors: number[][] = [];
  for (let i = 0; i < allTexts.length; i += batchSize) {
    const slice = allTexts.slice(i, i + batchSize);
    const res = await embedder.embed(slice);
    vectors.push(...res);
    if (delayMs > 0 && i + batchSize < allTexts.length) await new Promise(r => setTimeout(r, delayMs));
  }
  for (let i = 0; i < chunks.length; i++) chunks[i].vector = vectors[i];

  // Upsert to LanceDB
  await vector.upsertChunks(chunks);

  // Update state
  const nowIso = new Date().toISOString();
  state.upsert({
    pageId: doc.id,
    space: doc.spaceKey,
    title: doc.title,
    version: doc.version,
    updatedAt: doc.updatedAt,
    contentHash: hash,
    lastIndexedAt: nowIso,
    url: doc.url
  });
}

// Run once per invocation (cron/external scheduler should call the script periodically)
main().catch(err => {
  console.error('Ingest worker fatal error:', err);
  process.exit(1);
});
