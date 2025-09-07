import type { Chunk, Filters } from '@app/shared';

export interface VectorSearchResult {
  chunk: Chunk;
  score: number;
}

export interface VectorStore {
  upsertChunks(chunks: Chunk[]): Promise<void>;
  searchSimilar(vector: number[], filters: Filters, topK: number): Promise<VectorSearchResult[]>;
  deleteByPageId(pageId: string): Promise<void>;
  initialize(): Promise<void>;
}

export interface LanceDBConfig {
  dbPath: string;
  tableName?: string;
}

// TODO: Implement LanceDB when dependencies are added
export class MockVectorStore implements VectorStore {
  private chunks: Map<string, Chunk> = new Map();

  async initialize(): Promise<void> {
    // Mock implementation - no-op
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    const nowIso = new Date().toISOString();
    for (const chunk of chunks) {
      const enriched: Chunk = { ...chunk, indexedAt: nowIso };
      this.chunks.set(enriched.id, enriched);
    }
  }

  async searchSimilar(vector: number[], filters: Filters, topK: number): Promise<VectorSearchResult[]> {
    const allChunks = Array.from(this.chunks.values());
    
    // Apply filters
    let filtered = allChunks;
    if (filters.space) {
      filtered = filtered.filter(chunk => chunk.space === filters.space);
    }
    if (filters.labels && filters.labels.length > 0) {
      filtered = filtered.filter(chunk => 
        filters.labels!.some(label => chunk.labels.includes(label))
      );
    }
    if (filters.updatedAfter) {
      const cutoff = new Date(filters.updatedAfter);
      filtered = filtered.filter(chunk => new Date(chunk.updatedAt) >= cutoff);
    }

    // TTL filtering based on CHUNK_TTL_DAYS (default 7). Only filter out
    // chunks explicitly older than cutoff; chunks with missing indexedAt pass through.
    const ttlDays = parseInt(process.env.CHUNK_TTL_DAYS || '7', 10);
    if (!Number.isNaN(ttlDays) && ttlDays > 0) {
      const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(chunk => {
        if (!chunk.indexedAt) return true; // allow unknown age
        const t = Date.parse(chunk.indexedAt);
        return isNaN(t) ? true : t >= cutoffMs;
      });
    }

    // Mock similarity scoring (random for now)
    const results: VectorSearchResult[] = filtered
      .map(chunk => ({
        chunk,
        score: Math.random() // Mock similarity score
      }))
      .sort((a, b) => b.score - a.score) // Sort by descending score
      .slice(0, topK);

    return results;
  }

  async deleteByPageId(pageId: string): Promise<void> {
    for (const [id, chunk] of this.chunks.entries()) {
      if (chunk.pageId === pageId) {
        this.chunks.delete(id);
      }
    }
  }
}

// Real LanceDB implementation
export class LanceDBVectorStore implements VectorStore {
  private db: any = null;
  private table: any = null;
  private readonly tableName: string;
  private omitUrlField = false;
  private omitIndexedAtField = false;
  private warnedSchemaOnce = false;

  constructor(private config: LanceDBConfig) {
    this.tableName = config.tableName || 'confluence_chunks';
  }

  async initialize(): Promise<void> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      this.db = await lancedb.connect(this.config.dbPath);
      console.log(`LanceDB initialized successfully at: ${this.config.dbPath}`);
      // Eagerly open existing table if present to enable immediate search
      try {
        this.table = await this.db.openTable(this.tableName);
        console.log(`Opened existing LanceDB table: ${this.tableName}`);
        await this.ensureVectorIndex();
      } catch (err) {
        // Table may not exist yet; that's fine — it will be created on first upsert
      }
    } catch (error) {
      console.error('Failed to initialize LanceDB:', error);
      throw new Error(`LanceDB initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async ensureTable(): Promise<void> {
    if (this.table) return;
    try {
      this.table = await this.db.openTable(this.tableName);
    } catch {
      // no table yet
    }
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    try {
      // Convert chunks to LanceDB format
      const nowIso = new Date().toISOString();
      const recordsRaw = chunks.map(chunk => ({
        id: chunk.id,
        page_id: chunk.pageId,
        space: chunk.space || '',
        title: chunk.title,
        section_anchor: chunk.sectionAnchor || '', // Use empty string instead of null
        text: chunk.text,
        version: chunk.version,
        updated_at: chunk.updatedAt,
        labels: Array.isArray(chunk.labels) ? chunk.labels.join(',') : '', // Convert to comma-separated string
        vector: Array.isArray(chunk.vector) ? chunk.vector : [],
        url: chunk.url || '',
        indexed_at: nowIso
      }));

      const sanitize = (items: any[]) => items.map(r => {
        const copy: any = { ...r };
        if (this.omitUrlField) delete copy.url;
        if (this.omitIndexedAtField) delete copy.indexed_at;
        return copy;
      });
      let records = sanitize(recordsRaw);

      if (!this.table) {
        // Try to open existing table first, create if doesn't exist
        try {
          this.table = await this.db.openTable(this.tableName);
          console.log(`Opened existing LanceDB table: ${this.tableName}`);
        } catch (error) {
          // Table doesn't exist, create it
          this.table = await this.db.createTable(this.tableName, records);
          console.log(`Created LanceDB table: ${this.tableName} with ${records.length} records`);
          // Best-effort: create vector index for faster/more accurate ANN
          await this.ensureVectorIndex();
        }
      }
      
      if (this.table) {
        // Delete existing chunks for the same pages (upsert behavior)
        const pageIds = [...new Set(chunks.map(c => c.pageId))];
        for (const pageId of pageIds) {
          await this.table.delete(`page_id = '${pageId}'`);
        }
        
        // Add new records, aligning to existing schema if necessary
        try {
          await this.table.add(records);
        } catch (err: any) {
          const msg = String(err?.message || err);
          const strict = String(process.env.LANCEDB_STRICT_SCHEMA || '').toLowerCase() === 'true';
          if (!/Found field not in schema/i.test(msg) || strict) throw err;

          // Graceful downgrade: remember and drop unknown fields for subsequent writes
          const fieldRegex = /Found field not in schema:\s*(\w+)/i;
          const m = fieldRegex.exec(msg);
          const missing = m && m[1] ? m[1] : '';
          if (!this.warnedSchemaOnce) {
            console.warn('LanceDB schema mismatch detected; enabling compatibility mode. Missing field:', missing || 'unknown');
            this.warnedSchemaOnce = true;
          }
          if (missing.toLowerCase() === 'url') this.omitUrlField = true;
          if (missing.toLowerCase() === 'indexed_at') this.omitIndexedAtField = true;
          records = sanitize(recordsRaw);
          await this.table.add(records);
        }
        console.log(`Added ${records.length} records to LanceDB table: ${this.tableName}`);
      }
    } catch (error) {
      console.error('Failed to upsert chunks to LanceDB:', error);
      throw new Error(`LanceDB upsert failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async searchSimilar(vector: number[], filters: Filters, topK: number): Promise<VectorSearchResult[]> {
    if (!this.table) {
      await this.ensureTable();
    }
    if (!this.table) {
      console.warn('LanceDB table not initialized, returning empty results');
      return [];
    }

    try {
      let query = this.table.search(vector).limit(topK);
      // Prefer cosine similarity if available
      try { if (typeof query.metricType === 'function') query = query.metricType('cosine'); } catch {}

      // Optional ANN tuning parameters (no-op if unsupported by current LanceDB)
      const nprobes = Number(process.env.LANCEDB_NPROBES || 0);
      const efSearch = Number(process.env.LANCEDB_EF_SEARCH || 0);
      const refine = Number(process.env.LANCEDB_REFINE_FACTOR || 0);
      try { if (nprobes > 0 && typeof (query as any).nprobes === 'function') query = (query as any).nprobes(nprobes); } catch {}
      try { if (efSearch > 0 && typeof (query as any).efSearch === 'function') query = (query as any).efSearch(efSearch); } catch {}
      try { if (refine > 0 && typeof (query as any).refineFactor === 'function') query = (query as any).refineFactor(refine); } catch {}

      // Apply filters
      const whereConditions: string[] = [];
      if (filters.space) {
        whereConditions.push(`space = '${filters.space.replace(/'/g, "''")}'`);
      }
      if (filters.labels && filters.labels.length > 0) {
        // Labels are stored as a comma-separated string. Use LIKE for a pragmatic match.
        const labelConditions = filters.labels.map(label => {
          const safe = label.replace(/'/g, "''");
          return `labels LIKE '%${safe}%'`;
        }).join(' OR ');
        whereConditions.push(`(${labelConditions})`);
      }
      if (filters.updatedAfter) {
        whereConditions.push(`updated_at >= '${filters.updatedAfter}'`);
      }

      if (whereConditions.length > 0) {
        query = query.where(whereConditions.join(' AND '));
      }

      const results = await query.toArray();

      // Map to VectorSearchResult
      const mapped: VectorSearchResult[] = results.map((record: any) => ({
        chunk: {
          id: record.id,
          pageId: record.page_id,
          space: record.space,
          title: record.title,
          sectionAnchor: record.section_anchor,
          text: record.text,
          version: record.version,
          updatedAt: record.updated_at,
          labels: record.labels ? String(record.labels).split(',').filter(Boolean) : [],
          vector: record.vector,
          url: record.url || undefined,
          indexedAt: record.indexed_at || undefined
        },
        score: record._distance ? 1 - record._distance : 1
      }));

      // TTL post-filtering to avoid schema issues on legacy tables
      const ttlDays = parseInt(process.env.CHUNK_TTL_DAYS || '7', 10);
      if (Number.isNaN(ttlDays) || ttlDays <= 0) return mapped;
      const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
      return mapped.filter(r => {
        const t = r.chunk.indexedAt ? Date.parse(r.chunk.indexedAt) : NaN;
        return isNaN(t) ? true : t >= cutoffMs;
      });
    } catch (error) {
      console.error('Failed to search LanceDB:', error);
      return []; // Return empty results rather than throwing
    }
  }

  async deleteByPageId(pageId: string): Promise<void> {
    if (!this.table) {
      console.warn('LanceDB table not initialized, skipping delete');
      return;
    }

    try {
      await this.table.delete(`page_id = '${pageId.replace(/'/g, "''")}'`);
      console.log(`Deleted chunks for page: ${pageId}`);
    } catch (error) {
      console.error(`Failed to delete chunks for page ${pageId}:`, error);
      throw new Error(`LanceDB delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Best-effort stats for diagnostics (dev convenience).
  async getStats(limit = 5): Promise<{ count: number | null; recent: Array<{ id: string; page_id: string; title?: string; indexed_at?: string }> }> {
    await this.ensureTable();
    if (!this.table) return { count: 0, recent: [] };
    let count: number | null = null;
    try {
      if (typeof this.table.countRows === 'function') {
        count = await this.table.countRows();
      }
    } catch {
      count = null;
    }
    let recent: Array<{ id: string; page_id: string; title?: string; indexed_at?: string }> = [];
    try {
      // Warning: toArray() can be heavy for large tables; acceptable for dev diagnostics.
      const arr: any[] = await this.table.toArray();
      arr.sort((a, b) => {
        const ta = Date.parse(a.indexed_at || '');
        const tb = Date.parse(b.indexed_at || '');
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
      });
      recent = arr.slice(0, limit).map(r => ({ id: r.id, page_id: r.page_id, title: r.title, indexed_at: r.indexed_at }));
      if (count === null) count = arr.length;
    } catch {
      // ignore
    }
    return { count, recent };
  }

  // Internal: best-effort vector index creation with sensible defaults.
  // Safely no-ops if the current LanceDB version doesn’t support these APIs or the index already exists.
  // Uses HNSW when available; falls back to IVF_PQ parameters otherwise.
  private async ensureVectorIndex(): Promise<void> {
    try {
      const tbl: any = this.table;
      if (!tbl || typeof tbl.listIndexes !== 'function' || typeof tbl.createIndex !== 'function') return;
      const idxs = await tbl.listIndexes();
      const hasVector = Array.isArray(idxs) && idxs.some((i: any) => String(i?.name || '').toLowerCase().includes('vector'));
      if (hasVector) return;

      const metric = (process.env.LANCEDB_METRIC || 'cosine').toLowerCase();
      const preferHnsw = String(process.env.LANCEDB_USE_HNSW || 'true').toLowerCase() !== 'false';
      const M = Number(process.env.LANCEDB_HNSW_M || 16);
      const efc = Number(process.env.LANCEDB_HNSW_EF_CONSTRUCTION || 200);
      const numParts = Number(process.env.LANCEDB_IVF_PARTITIONS || 256);
      const pqSubs = Number(process.env.LANCEDB_PQ_SUBVECTORS || 96);

      // Try HNSW first
      if (preferHnsw) {
        try {
          await tbl.createIndex({
            name: 'vector_hnsw',
            column: 'vector',
            type: 'HNSW',
            metricType: metric,
            hnswParams: { M, ef_construction: efc }
          });
          console.log('Created HNSW vector index on LanceDB table');
          return;
        } catch (e) {
          // Fall through to IVF_PQ attempt
          console.warn('HNSW index creation not supported or failed. Falling back to IVF_PQ. Error:', e instanceof Error ? e.message : String(e));
        }
      }

      // Fallback: IVF_PQ
      try {
        await tbl.createIndex({
          name: 'vector_ivfpq',
          column: 'vector',
          type: 'IVF_PQ',
          metricType: metric,
          ivfParams: { num_partitions: numParts },
          pqParams: { num_sub_vectors: pqSubs }
        });
        console.log('Created IVF_PQ vector index on LanceDB table');
      } catch (e2) {
        console.warn('IVF_PQ index creation not supported or failed. Continuing without explicit index. Error:', e2 instanceof Error ? e2.message : String(e2));
      }
    } catch (err) {
      // Don’t fail app startup for index issues
      console.warn('Vector index setup skipped due to error:', err instanceof Error ? err.message : String(err));
    }
  }
}
