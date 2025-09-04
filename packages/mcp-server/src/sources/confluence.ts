import type { DocumentSource, DocumentSourceClient, SearchParams, SearchResponse } from './interfaces.js';

export interface ConfluenceConfig {
  baseUrl: string;
  username: string;
  apiToken: string;
  timeoutMs?: number;
}

interface ConfluenceApiPage {
  id: string;
  title: string;
  type: string;
  space: {
    key: string;
    name: string;
  };
  version: {
    number: number;
    when: string;
  };
  body?: {
    storage: {
      value: string;
      representation: string;
    };
  };
  metadata?: {
    labels?: {
      results: Array<{
        name: string;
      }>;
    };
  };
  _links: {
    webui: string;
    base?: string;
  };
}

interface ConfluenceSearchResponse {
  results: ConfluenceApiPage[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
}

export class ConfluenceClient implements DocumentSourceClient {
  constructor(private config: ConfluenceConfig) {}

  getName(): string {
    return 'confluence';
  }

  async searchDocuments(params: SearchParams): Promise<SearchResponse> {
    const cql = this.buildCQL(params);
    const { limit = 25, start = 0 } = params;

    // Try the content search endpoint first (works on many Apache Confluence versions).
    try {
      return await this.searchViaContentSearch(cql, limit, start);
    } catch (err) {
      // Fallback to the generic CQL search endpoint (broader compatibility).
      console.warn('Content search failed; falling back to CQL search:', String(err));
      return await this.searchViaCqlSearch(cql, limit, start);
    }
  }

  async getDocumentById(id: string): Promise<DocumentSource> {
    const params = new URLSearchParams({
      expand: 'body.storage,version,space,metadata.labels'
    });
    const url = `${this.config.baseUrl}/rest/api/content/${id}?${params}`;
    const response = await this.fetch(url);
    const apiPage: ConfluenceApiPage = await response.json();
    
    return this.apiPageToDocumentSource(apiPage);
  }

  // List pages by space without using CQL (paginates the content endpoint)
  async listPagesBySpace(spaceKey: string, start = 0, limit = 50): Promise<SearchResponse> {
    const params = new URLSearchParams({
      type: 'page',
      spaceKey,
      start: String(start),
      limit: String(Math.min(limit, 100)), // Confluence often caps at 100
      expand: 'body.storage,version,metadata.labels,space'
    });
    const url = this.joinUrl(this.config.baseUrl, `/rest/api/content?${params}`);
    console.log('Confluence API Request (content list):', url);
    const response = await this.fetch(url);
    const data: ConfluenceSearchResponse = await response.json();
    return {
      documents: data.results.map(this.apiPageToDocumentSource.bind(this)),
      start: data.start,
      limit: data.limit,
      total: data.totalSize || data.size
    };
  }

  private buildCQL(params: SearchParams): string {
    // Build a conservative CQL compatible with Apache Confluence.
    const parts: string[] = [];

    if (params.query) {
      // Tokenize and keep meaningful terms; AND them to improve recall with typos
      const stop = new Set(['how','do','i','use','what','is','the','a','an','to','of','for','about','tell','me']);
      const tokens = params.query
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(w => !stop.has(w))
        .map(w => w.trim())
        .filter(w => w.length >= 3);

      const unique = Array.from(new Set(tokens));
      const top = unique.slice(0, 4); // cap terms

      if (top.length > 0) {
        const andTerms = top.map(t => `text ~ "${t}"`).join(' and ');
        parts.push(`(${andTerms})`);
      } else {
        // Fallback to original phrase if nothing survived
        parts.push(`text ~ "${params.query}"`);
      }
    }

    parts.push('type = page');

    if (params.space) {
      parts.push(`space = "${params.space}"`);
    }

    if (params.labels && params.labels.length > 0) {
      const labelExpr = params.labels.map(l => `label = "${l}"`).join(' or ');
      parts.push(`(${labelExpr})`);
    }

    if (params.updatedAfter) {
      parts.push(`lastmodified > "${params.updatedAfter}"`);
    }

    const cql = parts.join(' and ');
    console.log('Confluence CQL:', cql);
    return cql;
  }

  private apiPageToDocumentSource(apiPage: ConfluenceApiPage): DocumentSource {
    return {
      id: apiPage.id,
      title: apiPage.title,
      spaceKey: apiPage.space.key,
      version: apiPage.version.number,
      labels: apiPage.metadata?.labels?.results?.map(l => l.name) || [],
      updatedAt: apiPage.version.when,
      url: apiPage._links.base ? `${apiPage._links.base}${apiPage._links.webui}` : apiPage._links.webui,
      content: apiPage.body?.storage?.value || ''
    };
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? 30000; // Increased timeout for public APIs
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        // Avoid sending Content-Type on GET to prevent 415 errors on some servers
        ...(init && (init as any).method && (init as any).method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        // Set a UA to appease stricter proxies/filters
        'User-Agent': 'offline-mcp-server/0.1'
      };

      // Add custom headers from init if provided
      if (init?.headers) {
        Object.assign(headers, init.headers);
      }

      // Add authentication only if not using public access
      const isPublicAccess = this.config.username === 'public' || !this.config.username || !this.config.apiToken;
      if (!isPublicAccess) {
        const auth = Buffer.from(`${this.config.username}:${this.config.apiToken}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
      }

      // Optional corporate proxy support via HTTPS_PROXY/HTTP_PROXY
      let dispatcher: any = undefined;
      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxy) {
        try {
          const undici = await import('undici');
          const ProxyAgent = (undici as any).ProxyAgent;
          dispatcher = new ProxyAgent(proxy);
        } catch {
          // ignore if undici import fails; proceed without proxy
        }
      }

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers,
        // @ts-ignore: dispatcher is undici-specific
        dispatcher
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Confluence API ${response.status}: ${errorText}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  private async searchViaContentSearch(cql: string, limit: number, start: number): Promise<SearchResponse> {
    const searchParams = new URLSearchParams({
      cql,
      limit: String(limit),
      start: String(start),
      expand: 'body.storage,version,metadata.labels,space'
    });

    const url = this.joinUrl(this.config.baseUrl, `/rest/api/content/search?${searchParams}`);
    console.log('Confluence API Request (content/search):', url);

    const response = await this.fetch(url);
    const data: ConfluenceSearchResponse = await response.json();

    return {
      documents: data.results.map(this.apiPageToDocumentSource.bind(this)),
      start: data.start,
      limit: data.limit,
      total: data.totalSize || data.size
    };
  }

  private async searchViaCqlSearch(cql: string, limit: number, start: number): Promise<SearchResponse> {
    const searchParams = new URLSearchParams({
      cql,
      limit: String(limit),
      start: String(start),
      // Try to expand nested content info when supported
      expand: 'content.space,content.version'
    });

    const url = this.joinUrl(this.config.baseUrl, `/rest/api/search?${searchParams}`);
    console.log('Confluence API Request (search):', url);

    const res = await this.fetch(url);
    const json = await res.json() as any;

    // CQL search results vary; prefer fetching full docs by ID to ensure consistent shape
    const items: Array<{ id?: string; content?: { id?: string }; title?: string }> = json.results || [];
    const ids = items
      .map(r => r?.content?.id || r?.id)
      .filter((id: unknown): id is string => typeof id === 'string');

    const documents: DocumentSource[] = [];
    for (const id of ids) {
      try {
        const doc = await this.getDocumentById(id);
        documents.push(doc);
      } catch (e) {
        console.warn('Failed to fetch document by id from search results:', id, e);
      }
    }

    return {
      documents,
      start: typeof json.start === 'number' ? json.start : start,
      limit: typeof json.limit === 'number' ? json.limit : limit,
      total: typeof json.totalSize === 'number' ? json.totalSize : (typeof json.size === 'number' ? json.size : documents.length)
    };
  }

  private joinUrl(base: string, path: string): string {
    // Ensures we don't end up with double slashes
    if (base.endsWith('/') && path.startsWith('/')) return base.slice(0, -1) + path;
    if (!base.endsWith('/') && !path.startsWith('/')) return `${base}/${path}`;
    return base + path;
  }
}
