import fs from 'node:fs/promises';
import path from 'node:path';

export interface CrawlerConfig {
  allSpaces: boolean; // if true, ignore spaces and crawl all
  spaces: string[];   // used when allSpaces=false
  pageSize: number;   // 1..100
  maxPagesPerTick: number; // 1..100000
  concurrency: number; // 1..64
  cron?: string; // optional cron for external scheduler
}

const DEFAULTS: CrawlerConfig = {
  allSpaces: true,
  spaces: [],
  pageSize: 50,
  maxPagesPerTick: 200,
  concurrency: 4
};

export class CrawlerConfigStore {
  private file: string;

  constructor(repoRoot: string, filename = 'data/crawler-config.json') {
    this.file = path.isAbsolute(filename) ? filename : path.resolve(repoRoot, filename);
  }

  async load(): Promise<CrawlerConfig> {
    try {
      const txt = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(txt);
      return this.validate({ ...DEFAULTS, ...parsed });
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        await this.save(DEFAULTS);
        return DEFAULTS;
      }
      throw err;
    }
  }

  async save(cfg: CrawlerConfig): Promise<void> {
    const validated = this.validate(cfg);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(validated, null, 2), 'utf8');
  }

  validate(cfg: CrawlerConfig): CrawlerConfig {
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(x)));
    const pageSize = clamp(Number(cfg.pageSize || DEFAULTS.pageSize), 1, 100);
    const maxPagesPerTick = clamp(Number(cfg.maxPagesPerTick || DEFAULTS.maxPagesPerTick), 1, 100000);
    const concurrency = clamp(Number(cfg.concurrency || DEFAULTS.concurrency), 1, 64);
    const allSpaces = Boolean(cfg.allSpaces);
    const spaces = Array.isArray(cfg.spaces) ? cfg.spaces.map(s => String(s).trim()).filter(Boolean) : [];
    const cron = cfg.cron ? String(cfg.cron).trim() : undefined;
    return { allSpaces, spaces, pageSize, maxPagesPerTick, concurrency, cron };
  }
}

