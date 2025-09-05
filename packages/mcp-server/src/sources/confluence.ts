import type { DocumentSource, DocumentSourceClient, SearchParams, SearchResponse } from './interfaces.js';
import * as https from 'https';

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
    // Temporary: Use mock data when network is restricted
    if (process.env.USE_MOCK_DATA === 'true') {
      return this.getMockSearchResults(params);
    }

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
      // Improved query building for better search results
      const stop = new Set(['how','do','i','use','what','is','the','a','an','to','of','for','about','tell','me','can','you','help','with','have','info','information','we','on','in','at','it','that','this']);
      const tokens = params.query
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(w => !stop.has(w))
        .map(w => w.trim())
        .filter(w => w.length >= 2); // Allow 2-char terms for things like CVE IDs

      const unique = Array.from(new Set(tokens));
      
      // Prioritize important terms (CVEs, technical terms, etc.)
      const important = unique.filter(t => 
        t.startsWith('cve-') || 
        (t.length >= 6 && !['information'].includes(t)) || 
        (/^[A-Z0-9-]{4,}$/i.test(t) && t.length >= 4)
      );
      
      if (important.length > 0) {
        // Use OR for important terms to be less restrictive
        const orTerms = important.slice(0, 3).map(t => `text ~ "${t}"`).join(' or ');
        parts.push(`(${orTerms})`);
      } else if (unique.length > 0) {
        // For regular queries, use AND for first 2 terms only
        const andTerms = unique.slice(0, 2).map(t => `text ~ "${t}"`).join(' and ');
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
    // Use native Node.js HTTPS module instead of fetch() due to environment restrictions
    return new Promise<Response>((resolve, reject) => {
      const urlObj = new URL(url);
      const timeoutMs = this.config.timeoutMs ?? 30000;

      const headers: Record<string, string> = {
        'Host': urlObj.hostname,
        'Accept': 'application/json',
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

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: init?.method || 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: true // Keep TLS validation
      };

      const req = https.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => data += chunk.toString());
        res.on('end', () => {
          // Create a fetch-like Response object
          const response = {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            json: async () => JSON.parse(data),
            text: async () => data
          } as Response;

          if (!response.ok) {
            reject(new Error(`Confluence API ${res.statusCode}: ${data}`));
          } else {
            resolve(response);
          }
        });
      });

      req.on('error', (err: Error) => {
        console.error('HTTPS request error details:', {
          message: err.message,
          code: (err as any).code,
          errno: (err as any).errno,
          syscall: (err as any).syscall,
          stack: err.stack
        });
        reject(new Error(`Network error: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      // Send request body if provided
      if (init?.body) {
        req.write(init.body);
      }

      req.end();
    });
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

  private getMockSearchResults(params: SearchParams): SearchResponse {
    // Mock data based on actual Kafka Authorization CLI content
    const mockDocs: DocumentSource[] = [
      {
        id: '61323986',
        title: 'Kafka Authorization Command Line Interface',
        spaceKey: 'KAFKA',
        version: 5,
        labels: ['kafka-cli', 'kafka-acls'],
        updatedAt: '2015-11-10T21:59:14.000Z',
        url: 'https://cwiki.apache.org/confluence/display/KAFKA/Kafka+Authorization+Command+Line+Interface',
        content: `# Kafka Authorization Command Line Interface

## Introduction
Kafka ships with a pluggable Authorizer and an out-of-box authorizer implementation that uses zookeeper to store all the acls. Kafka acls are defined in the general format of "Principal P is [Allowed/Denied] Operation O From Host H On Resource R". 

## Command Line interface
Kafka Authorization management CLI can be found under bin directory with all the other CLIs. The CLI script is called kafka-acls.sh.

### Adding Acls
To add an acl "Principals User:Bob and User:Alice are allowed to perform Operation Read and Write on Topic Test-Topic from Host1 and Host2":

\`\`\`bash
bin/kafka-acls.sh --authorizer kafka.security.auth.SimpleAclAuthorizer --authorizer-properties zookeeper.connect=localhost:2181 --add --allow-principal User:Bob --allow-principal User:Alice --allow-hosts Host1,Host2 --operations Read,Write --topic Test-topic
\`\`\`

### Removing Acls
\`\`\`bash
bin/kafka-acls.sh --authorizer kafka.security.auth.SimpleAclAuthorizer --authorizer-properties zookeeper.connect=localhost:2181 --remove --allow-principal User:Bob --allow-principal User:Alice --allow-hosts Host1,Host2 --operations Read,Write --topic Test-topic
\`\`\`

### List Acls
\`\`\`bash
bin/kafka-acls.sh --authorizer kafka.security.auth.SimpleAclAuthorizer --authorizer-properties zookeeper.connect=localhost:2181 --list --topic Test-topic
\`\`\``
      },
      {
        id: '51807580',
        title: 'KIP-11 - Authorization Interface',
        spaceKey: 'KAFKA',
        version: 128,
        labels: ['kip-11', 'authorization'],
        updatedAt: '2015-10-27T00:49:06.000Z',
        url: 'https://cwiki.apache.org/confluence/display/KAFKA/KIP-11+-+Authorization+Interface',
        content: `# KIP-11 - Authorization Interface

## Motivation
As more enterprises have started using Kafka, there is increasing demand for authorization for who can publish or consume from topics. Authorization can be based on different available session attributes like user, IP, common name in certificate, etc.

## Public Interfaces
The APIs will now do authorizations so clients will see a new exception if they are not authorized for an operation.

### Operations and Resources
- READ: Topic, ConsumerGroup
- WRITE: Topic  
- CREATE: Cluster
- DELETE: Topics
- ALTER: Topics
- DESCRIBE: Topic, Cluster
- CLUSTER_ACTION: Cluster

## Default Implementation: SimpleAclAuthorizer
- Uses zookeeper as storage layer for ACLs
- Deny takes precedence over Allow
- When no ACL is attached to a resource, denies all requests
- Allows principals with READ or WRITE permission the DESCRIBE operation as well`
      }
    ];

    // Filter based on query if provided
    if (params.query) {
      const queryLower = params.query.toLowerCase();
      console.log('Mock search: Filtering for query:', queryLower);
      
      // Split query into keywords and check if any match
      const keywords = queryLower.split(/\s+/);
      const filtered = mockDocs.filter(doc => {
        const titleLower = doc.title.toLowerCase();
        const contentLower = doc.content.toLowerCase();
        const combined = titleLower + ' ' + contentLower;
        
        // Check if any keyword matches
        const matches = keywords.some(keyword => combined.includes(keyword));
        console.log(`Mock search: Document "${doc.title}" matches:`, matches);
        return matches;
      });
      
      console.log('Mock search: Found', filtered.length, 'matching documents');
      return {
        documents: filtered.slice(0, params.limit || 25),
        start: 0,
        limit: params.limit || 25,
        total: filtered.length
      };
    }

    return {
      documents: mockDocs.slice(0, params.limit || 25),
      start: 0,
      limit: params.limit || 25,
      total: mockDocs.length
    };
  }
}
