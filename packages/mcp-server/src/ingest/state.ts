import fs from 'node:fs/promises';
import path from 'node:path';

export interface PageState {
  pageId: string;
  space: string;
  title: string;
  version: number;
  updatedAt: string;
  contentHash: string;
  lastIndexedAt: string; // ISO8601
  url?: string;
}

export interface StateSnapshot {
  pages: Record<string, PageState>; // key = pageId
}

/**
 * Lightweight JSON state store for ingestion idempotency. For production, replace
 * with Postgres/Redis-backed store. This is safe for single-process ingestion.
 */
export class JsonStateStore {
  private file: string;
  private data: StateSnapshot = { pages: {} };

  constructor(repoRoot: string, filename = 'data/ingest-state.json') {
    this.file = path.isAbsolute(filename) ? filename : path.resolve(repoRoot, filename);
  }

  async load(): Promise<void> {
    try {
      const txt = await fs.readFile(this.file, 'utf8');
      this.data = JSON.parse(txt);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        await this.persist();
      } else {
        throw err;
      }
    }
  }

  async persist(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(pageId: string): PageState | undefined {
    return this.data.pages[pageId];
  }

  upsert(state: PageState): void {
    this.data.pages[state.pageId] = state;
  }
}

