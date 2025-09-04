export interface DocumentSource {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  labels: string[];
  updatedAt: string; // ISO8601
  url?: string;
  content: string; // HTML or markdown content
}

export interface SearchParams {
  query: string;
  space?: string;
  labels?: string[];
  updatedAfter?: string;
  limit?: number;
  start?: number;
}

export interface SearchResponse {
  documents: DocumentSource[];
  start: number;
  limit: number;
  total: number;
}

export interface DocumentSourceClient {
  searchDocuments(params: SearchParams): Promise<SearchResponse>;
  getDocumentById(id: string): Promise<DocumentSource>;
  getName(): string;
}