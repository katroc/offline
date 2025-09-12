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
  indexedAt?: string; // ISO8601 timestamp when stored in vector DB
  metadata?: Record<string, any>; // optional metadata for enhanced chunking
}

export interface Citation {
  pageId: string;
  title: string;
  url: string;
  sectionAnchor?: string;
  snippet?: string;
}

export interface RagQuery {
  question: string;
  space?: string;
  labels?: string[];
  updatedAfter?: string; // ISO8601
  topK?: number;
  model?: string; // Optional model override
  conversationId?: string; // Optional conversation/thread identifier
  ragBypass?: boolean; // Optional flag to bypass RAG and use direct LLM interaction
}

export interface RagResponse {
  answer: string;
  citations: Citation[];
  // Optional: display-ready deduped citations while preserving original mapping
  displayCitations?: Citation[];
  // Optional: map from original citation index -> displayCitations index
  citationIndexMap?: number[];
}

export interface Filters {
  space?: string;
  labels?: string[];
  updatedAfter?: string;
}

// Strip all <think>...</think> blocks from a string
export function stripThinking(input: string): string {
  if (!input) {return '';}
  try {
    const rawClosed = /<think(?:\s[^>]*)?>[\s\S]*?<\/think>\s*/gi;
    const escClosed = /&lt;think(?:\s[^&]*)&gt;[\s\S]*?&lt;\/think&gt;\s*/gi;
    let out = input.replace(rawClosed, '').replace(escClosed, '');

    // Also handle orphan opening tags (no closing tag) — strip to end of text
    const rawOrphan = /<think(?:\s[^>]*)?>[\s\S]*$/i;
    const escOrphan = /&lt;think(?:\s[^&]*)&gt;[\s\S]*$/i;
    out = out.replace(rawOrphan, '').replace(escOrphan, '');

    return out.trim();
  } catch {
    return input;
  }
}
