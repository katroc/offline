export interface ConfluencePage {
  id: string;
  title: string;
  spaceKey: string;
  version: number;
  labels: string[];
  updatedAt: string; // ISO8601
  url?: string;
}

export interface Chunk {
  id: string; // uuid or hash
  pageId: string;
  space: string;
  title: string;
  sectionAnchor?: string;
  text: string;
  version: number;
  updatedAt: string; // ISO8601
  labels: string[];
  vector?: number[]; // optional until embedded
  url?: string; // optional source URL for citations
}

export interface Citation {
  pageId: string;
  title: string;
  url: string;
  sectionAnchor?: string;
}

export interface RagQuery {
  question: string;
  space?: string;
  labels?: string[];
  updatedAfter?: string; // ISO8601
  topK?: number;
  model?: string; // Optional model override
}

export interface RagResponse {
  answer: string;
  citations: Citation[];
}

export interface Filters {
  space?: string;
  labels?: string[];
  updatedAfter?: string;
}
