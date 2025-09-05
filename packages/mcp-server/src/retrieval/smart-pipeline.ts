import type { RAGPipeline, RetrievalResult } from './pipeline.js';
import type { Filters } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LLMDocumentAnalyzer, type ConversationContext } from './llm-document-analyzer.js';
import { SimpleChunker } from './chunker.js';
import type { Citation } from '@app/shared';

/**
 * Smart RAG pipeline that uses LLM to analyze full documents for relevance
 * Falls back to traditional CQL search when needed
 */
export class SmartRAGPipeline implements RAGPipeline {
  private analyzer = new LLMDocumentAnalyzer();
  private chunker = new SimpleChunker({ 
    targetChunkSize: 800, 
    maxChunkSize: 1200, 
    overlap: 200 
  });
  private conversationMemory: string[] = []; // Store recent queries

  constructor(
    private documentClient: DocumentSourceClient
  ) {}

  async retrieveForQuery(
    query: string, 
    filters: Filters, 
    topK: number, 
    model?: string
  ): Promise<RetrievalResult> {
    console.log(`Smart RAG Pipeline: Analyzing query "${query}"`);
    
    // Add to conversation memory
    this.conversationMemory.push(query);
    if (this.conversationMemory.length > 10) {
      this.conversationMemory = this.conversationMemory.slice(-10); // Keep last 10 queries
    }

    try {
      // Extract conversation context
      const context = await this.analyzer.extractConversationContext(
        this.conversationMemory, 
        model
      );
      console.log('Conversation context:', context);

      // Phase 1: Cast a wide net - get many potentially relevant documents
      const broadDocuments = await this.getBroadDocumentSet(query, filters);
      console.log(`Found ${broadDocuments.length} candidate documents for analysis`);

      if (broadDocuments.length === 0) {
        return { chunks: [], citations: [] };
      }

      // Phase 2: LLM analyzes each document for relevance
      const analyses = await this.analyzer.analyzeDocuments(
        query, 
        broadDocuments, 
        context, 
        model
      );

      console.log(`Analyzed ${analyses.length} documents:`);
      analyses.slice(0, 5).forEach(a => {
        console.log(`- ${a.document.title}: ${a.relevanceScore.toFixed(2)} (${a.answersQuery ? 'ANSWERS' : 'related'})`);
      });

      // Phase 3: Filter for high-relevance documents
      const relevantAnalyses = analyses.filter(a => 
        a.relevanceScore > 0.3 || a.answersQuery
      );

      if (relevantAnalyses.length === 0) {
        console.log('No highly relevant documents found, trying CQL fallback');
        return await this.cqlFallback(query, filters, topK, model);
      }

      // Phase 4: Convert to chunks using extracted relevant sections
      const chunks = await this.analysesToChunks(relevantAnalyses, topK);
      const citations = this.chunksToCitations(chunks);

      console.log(`Returning ${chunks.length} chunks from ${relevantAnalyses.length} relevant documents`);
      return { chunks, citations };

    } catch (error) {
      console.warn('Smart analysis failed, falling back to CQL:', error);
      return await this.cqlFallback(query, filters, topK, model);
    }
  }

  /**
   * Get a broad set of documents that might be relevant
   * Uses multiple strategies to cast a wide net
   */
  private async getBroadDocumentSet(
    query: string, 
    filters: Filters
  ): Promise<DocumentSource[]> {
    const strategies: Promise<DocumentSource[]>[] = [];

    // Strategy 1: Broad keyword search (very permissive)
    strategies.push(this.broadKeywordSearch(query, filters));

    // Strategy 2: Entity extraction search (look for specific entities)
    const entities = this.extractEntities(query);
    if (entities.length > 0) {
      strategies.push(this.entitySearch(entities, filters));
    }

    // Strategy 3: Topic-based search (if query suggests specific topics)
    const topics = this.extractTopics(query);
    if (topics.length > 0) {
      strategies.push(this.topicSearch(topics, filters));
    }

    // Combine all results and deduplicate
    const allResults = await Promise.all(strategies);
    const seen = new Set<string>();
    const combined: DocumentSource[] = [];

    for (const results of allResults) {
      for (const doc of results) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          combined.push(doc);
        }
      }
    }

    // Limit to reasonable number for LLM analysis (cost control)
    return combined.slice(0, 20);
  }

  /**
   * Broad keyword search - much more permissive than current CQL
   */
  private async broadKeywordSearch(
    query: string, 
    filters: Filters
  ): Promise<DocumentSource[]> {
    try {
      // Use OR-based search for broader results
      const response = await this.documentClient.searchDocuments({
        query: this.buildBroadQuery(query),
        ...filters,
        limit: 15
      });
      return response.documents;
    } catch (error) {
      console.warn('Broad keyword search failed:', error);
      return [];
    }
  }

  /**
   * Build a broader, more permissive search query
   */
  private buildBroadQuery(query: string): string {
    // Extract key terms but be less restrictive
    const words = query.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .filter(w => !['what', 'how', 'the', 'can', 'you', 'help', 'with'].includes(w));

    // Use just the most important terms
    return words.slice(0, 3).join(' ');
  }

  /**
   * Search for specific entities (CVEs, product names, etc.)
   */
  private async entitySearch(entities: string[], filters: Filters): Promise<DocumentSource[]> {
    const results: DocumentSource[] = [];
    
    for (const entity of entities) {
      try {
        const response = await this.documentClient.searchDocuments({
          query: entity,
          ...filters,
          limit: 10
        });
        results.push(...response.documents);
      } catch (error) {
        console.warn(`Entity search failed for ${entity}:`, error);
      }
    }
    
    return results;
  }

  /**
   * Search based on inferred topics
   */
  private async topicSearch(topics: string[], filters: Filters): Promise<DocumentSource[]> {
    const results: DocumentSource[] = [];
    
    for (const topic of topics) {
      try {
        const response = await this.documentClient.searchDocuments({
          query: topic,
          ...filters,
          limit: 8
        });
        results.push(...response.documents);
      } catch (error) {
        console.warn(`Topic search failed for ${topic}:`, error);
      }
    }
    
    return results;
  }

  /**
   * Extract entities from query (simple heuristics)
   */
  private extractEntities(query: string): string[] {
    const entities: string[] = [];
    
    // CVE pattern
    const cveMatch = query.match(/CVE-\d{4}-\d+/gi);
    if (cveMatch) entities.push(...cveMatch);
    
    // Product names (simple heuristic)
    const words = query.split(/\s+/);
    for (const word of words) {
      if (word.length > 4 && /^[A-Z]/.test(word)) {
        entities.push(word);
      }
    }
    
    return entities;
  }

  /**
   * Extract topics from query (simple heuristics)
   */
  private extractTopics(query: string): string[] {
    const topics: string[] = [];
    
    // Security-related
    if (/security|vulnerability|CVE|exploit/i.test(query)) {
      topics.push('security');
    }
    
    // Configuration-related
    if (/config|setup|install|configure/i.test(query)) {
      topics.push('configuration');
    }
    
    // Troubleshooting-related  
    if (/error|problem|issue|fix|troubleshoot/i.test(query)) {
      topics.push('troubleshooting');
    }
    
    return topics;
  }

  /**
   * Convert analysis results to chunks, prioritizing relevant sections
   */
  private async analysesToChunks(
    analyses: any[], 
    topK: number
  ): Promise<any[]> {
    const chunks: any[] = [];
    
    for (const analysis of analyses.slice(0, topK)) {
      const doc = analysis.document;
      
      // If we have relevant sections extracted, use those
      if (analysis.relevantSections && analysis.relevantSections.length > 0) {
        for (const section of analysis.relevantSections.slice(0, 2)) { // Max 2 sections per doc
          chunks.push({
            pageId: doc.id,
            title: doc.title,
            spaceKey: doc.spaceKey,
            sectionAnchor: undefined,
            text: section,
            version: doc.version,
            updatedAt: doc.updatedAt,
            labels: doc.labels,
            url: doc.url
          });
        }
      } else {
        // Fall back to chunking the full document
        const page = {
          id: doc.id,
          title: doc.title,
          spaceKey: doc.spaceKey,
          version: doc.version,
          labels: doc.labels,
          updatedAt: doc.updatedAt,
          url: doc.url
        };
        
        const docChunks = await this.chunker.chunkDocument(page, doc.content);
        chunks.push(...docChunks.slice(0, 1)); // Take first chunk only
      }
      
      if (chunks.length >= topK) break;
    }
    
    return chunks;
  }

  /**
   * CQL-based fallback when smart analysis fails
   */
  private async cqlFallback(
    query: string, 
    filters: Filters, 
    topK: number, 
    model?: string
  ): Promise<RetrievalResult> {
    console.log('Using CQL fallback search');
    
    try {
      const response = await this.documentClient.searchDocuments({
        query,
        ...filters,
        limit: topK
      });
      
      if (response.documents.length === 0) {
        return { chunks: [], citations: [] };
      }
      
      // Simple chunking of fallback results
      const chunks: any[] = [];
      for (const doc of response.documents.slice(0, topK)) {
        const page = {
          id: doc.id,
          title: doc.title,
          spaceKey: doc.spaceKey,
          version: doc.version,
          labels: doc.labels,
          updatedAt: doc.updatedAt,
          url: doc.url
        };
        
        const docChunks = await this.chunker.chunkDocument(page, doc.content);
        chunks.push(...docChunks.slice(0, 1));
      }
      
      return { chunks, citations: this.chunksToCitations(chunks) };
      
    } catch (error) {
      console.error('CQL fallback also failed:', error);
      return { chunks: [], citations: [] };
    }
  }

  /**
   * Convert chunks to citations
   */
  private chunksToCitations(chunks: any[]): Citation[] {
    const citationMap = new Map<string, Citation>();
    
    for (const chunk of chunks) {
      const key = `${chunk.pageId}-${chunk.sectionAnchor || 'main'}`;
      if (!citationMap.has(key)) {
        const base = process.env.CONFLUENCE_BASE_URL || 'https://confluence.local';
        const baseUrl = base.endsWith('/') ? base.slice(0, -1) : base;
        
        let rawUrl: string;
        if (chunk.url && chunk.url.startsWith('http')) {
          rawUrl = chunk.url;
        } else if (chunk.url) {
          rawUrl = `${baseUrl}${chunk.url}`;
        } else {
          rawUrl = `${baseUrl}/pages/${chunk.pageId}`;
        }
        
        const url = chunk.sectionAnchor ? `${rawUrl}#${chunk.sectionAnchor}` : rawUrl;
        citationMap.set(key, {
          pageId: chunk.pageId,
          title: chunk.title,
          url,
          sectionAnchor: chunk.sectionAnchor
        });
      }
    }
    
    return Array.from(citationMap.values());
  }

  // Required by interface but not used in smart pipeline
  async indexDocument(document: DocumentSource): Promise<void> {
    // Not implemented - smart pipeline doesn't use local indexing
  }

  async deleteDocument(pageId: string): Promise<void> {
    // Not implemented - smart pipeline doesn't use local indexing  
  }
}