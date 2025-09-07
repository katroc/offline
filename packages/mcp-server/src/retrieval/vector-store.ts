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
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
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

  constructor(private config: LanceDBConfig) {
    this.tableName = config.tableName || 'confluence_chunks';
  }

  async initialize(): Promise<void> {
    try {
      const lancedb = await import('@lancedb/lancedb');
      this.db = await lancedb.connect(this.config.dbPath);
      console.log(`LanceDB initialized successfully at: ${this.config.dbPath}`);
    } catch (error) {
      console.error('Failed to initialize LanceDB:', error);
      throw new Error(`LanceDB initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    try {
      // Convert chunks to LanceDB format
      const records = chunks.map(chunk => ({
        id: chunk.id,
        page_id: chunk.pageId,
        space: chunk.space || '',
        title: chunk.title,
        section_anchor: chunk.sectionAnchor || '', // Use empty string instead of null
        text: chunk.text,
        version: chunk.version,
        updated_at: chunk.updatedAt,
        labels: Array.isArray(chunk.labels) ? chunk.labels.join(',') : '', // Convert to comma-separated string
        vector: Array.isArray(chunk.vector) ? chunk.vector : []
      }));

      if (!this.table) {
        // Try to open existing table first, create if doesn't exist
        try {
          this.table = await this.db.openTable(this.tableName);
          console.log(`Opened existing LanceDB table: ${this.tableName}`);
        } catch (error) {
          // Table doesn't exist, create it
          this.table = await this.db.createTable(this.tableName, records);
          console.log(`Created LanceDB table: ${this.tableName} with ${records.length} records`);
        }
      }
      
      if (this.table) {
        // Delete existing chunks for the same pages (upsert behavior)
        const pageIds = [...new Set(chunks.map(c => c.pageId))];
        for (const pageId of pageIds) {
          await this.table.delete(`page_id = '${pageId}'`);
        }
        
        // Add new records
        await this.table.add(records);
        console.log(`Added ${records.length} records to LanceDB table: ${this.tableName}`);
      }
    } catch (error) {
      console.error('Failed to upsert chunks to LanceDB:', error);
      throw new Error(`LanceDB upsert failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async searchSimilar(vector: number[], filters: Filters, topK: number): Promise<VectorSearchResult[]> {
    if (!this.table) {
      console.warn('LanceDB table not initialized, returning empty results');
      return [];
    }

    try {
      let query = this.table.search(vector).limit(topK);

      // Apply filters
      const whereConditions: string[] = [];
      if (filters.space) {
        whereConditions.push(`space = '${filters.space.replace(/'/g, "''")}'`);
      }
      if (filters.labels && filters.labels.length > 0) {
        const labelConditions = filters.labels.map(label => 
          `array_contains(labels, '${label.replace(/'/g, "''")}')`
        ).join(' OR ');
        whereConditions.push(`(${labelConditions})`);
      }
      if (filters.updatedAfter) {
        whereConditions.push(`updated_at >= '${filters.updatedAfter}'`);
      }

      if (whereConditions.length > 0) {
        query = query.where(whereConditions.join(' AND '));
      }

      const results = await query.toArray();
      
      return results.map((record: any) => ({
        chunk: {
          id: record.id,
          pageId: record.page_id,
          space: record.space,
          title: record.title,
          sectionAnchor: record.section_anchor,
          text: record.text,
          version: record.version,
          updatedAt: record.updated_at,
          labels: record.labels ? record.labels.split(',').filter(Boolean) : [], // Convert back to array
          vector: record.vector
        },
        score: record._distance ? 1 - record._distance : 1 // Convert distance to similarity score
      }));
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
}