import type { DocumentSource } from './interfaces.js';
import { ConfluenceClient } from './confluence.js';

export interface CrawlOptions {
  updatedAfter?: string; // ISO8601; client-side filtered
  maxPages?: number; // safety limit for initial sync
  pageSize?: number; // API page size (<=100)
}

export async function crawlSpace(
  client: ConfluenceClient,
  spaceKey: string,
  opts: CrawlOptions = {}
): Promise<DocumentSource[]> {
  const pageSize = Math.min(Math.max(opts.pageSize || 50, 1), 100);
  const maxPages = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : Infinity;
  const updatedAfterDate = opts.updatedAfter ? new Date(opts.updatedAfter) : null;

  const collected: DocumentSource[] = [];
  let start = 0;
  let pagesFetched = 0;

  while (pagesFetched < maxPages) {
    const batch = await client.listPagesBySpace(spaceKey, start, pageSize);
    const docs = batch.documents || [];
    
    for (const d of docs) {
      if (updatedAfterDate && new Date(d.updatedAt) < updatedAfterDate) continue;
      collected.push(d);
    }

    pagesFetched += 1;
    if (docs.length < pageSize) break; // last page
    start += pageSize;
  }

  console.log(`Crawl complete for space ${spaceKey}: collected ${collected.length} documents`);
  return collected;
}

