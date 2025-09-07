// Sketch retrieval pipeline interfaces (no implementations yet)

export interface ConfluenceSearchParams {
  cql: string;
  limit?: number;
  expand?: string[];
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  labels: string[];
  updatedAt: string; // ISO8601
  url?: string;
  storageXhtml?: string; // raw storage format if fetched
}

export interface Chunk {
  id: string;
  pageId: string;
  space: string;
  title: string;
  sectionAnchor?: string;
  text: string;
  version: number;
  updatedAt: string;
  labels: string[];
  vector?: number[];
  indexedAt?: string; // ISO8601 when stored in vector DB
}

export interface RagQuery {
  question: string;
  space?: string;
  labels?: string[];
  updatedAfter?: string;
  topK?: number;
}

export interface Citation {
  pageId: string;
  title: string;
  url: string;
  sectionAnchor?: string;
}

export interface RagResponse {
  answer: string;
  citations: Citation[];
}

export interface ConfluenceClient {
  search(params: ConfluenceSearchParams): Promise<ConfluencePage[]>;
  getPage(id: string, opts?: { expand?: string[] }): Promise<ConfluencePage | null>;
}

export interface HtmlToText {
  parseStorageXhtml(xhtml: string): Promise<{ text: string; sections: Array<{ anchor?: string; text: string }> }>;
}

export interface Chunker {
  chunkSections(input: { page: ConfluencePage; sections: Array<{ anchor?: string; text: string }> }): Promise<Chunk[]>;
}

export interface Embedder {
  dimensions: number;
  embed(batch: string[]): Promise<number[][]>;
}

export interface VectorStore {
  upsert(chunks: Chunk[]): Promise<void>;
  query(params: { vector: number[]; topK: number; filters?: { space?: string; labels?: string[]; updatedAfter?: string } }): Promise<Chunk[]>;
}

export interface Orchestrator {
  ragQuery(query: RagQuery): Promise<RagResponse>;
}
