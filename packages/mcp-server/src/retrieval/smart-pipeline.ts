import type { Filters } from '@app/shared';
import type { Citation } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import type { RAGPipeline, RetrievalResult } from './pipeline.js';
import { LLMDocumentAnalyzer, type ConversationContext } from './llm-document-analyzer.js';
import { simpleTextRelevanceScore } from './llm-search.js';
import { SimpleChunker } from './chunker.js';

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
  private conversationMemory = new Map<string, string[]>(); // Store recent queries per conversation

  constructor(
    private documentClient: DocumentSourceClient
  ) {}

  async retrieveForQuery(
    queries: string | string[], 
    filters: Filters, 
    topK: number, 
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    const convKey = conversationId || 'global';
    const variants = Array.isArray(queries) ? queries : [queries];
    const maxFallbacks = Math.max(0, parseInt(process.env.MAX_FALLBACK_QUERIES || '3', 10) || 3);
    const limited = variants.slice(0, 1 + maxFallbacks);
    if (intent) {
      console.log(`Smart Pipeline intent: ${intent.intent} (conf=${intent.confidence?.toFixed?.(2) ?? intent.confidence})`);
    }

    let lastResult: RetrievalResult = { chunks: [], citations: [] };
    for (let i = 0; i < limited.length; i++) {
      const q = limited[i];
      console.log(`Smart RAG: Attempt ${i + 1}/${limited.length} with query: "${q}" (conv=${convKey})`);
      const res = await this.retrieveSingleQuery(q, filters, topK, model, convKey);
      if (res.chunks.length > 0) {return res;}
      lastResult = res;
    }
    return lastResult;
  }

  private async retrieveSingleQuery(
    query: string,
    filters: Filters,
    topK: number,
    model: string | undefined,
    convKey: string
  ): Promise<RetrievalResult> {
    console.log(`Smart RAG Pipeline: Analyzing query "${query}" (conv=${convKey})`);
    
    // Add to per-conversation memory
    const mem = this.conversationMemory.get(convKey) || [];
    mem.push(query);
    if (mem.length > 10) {mem.splice(0, mem.length - 10);}
    this.conversationMemory.set(convKey, mem);

    try {
      // Extract conversation context
      const context = await this.analyzer.extractConversationContext(mem, model);
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

      // Phase 3: Check global relevance threshold from environment first
      const envThreshold = isFinite(Number(process.env.RELEVANCE_THRESHOLD)) 
        ? Number(process.env.RELEVANCE_THRESHOLD) 
        : 0.2; // Much more permissive default for general questions
      const maxRelevanceScore = analyses.length > 0 ? Math.max(...analyses.map(a => a.relevanceScore)) : 0;
      const hasDirectAnswer = analyses.some(a => a.answersQuery);
      
      // If no document meets the global threshold and none directly answer the query, return empty
      if (maxRelevanceScore <= envThreshold - 0.001 && !hasDirectAnswer) { // Allow small precision tolerance
        console.log(`No documents meet global relevance threshold ${envThreshold} (max: ${maxRelevanceScore.toFixed(3)}, hasDirectAnswer: ${hasDirectAnswer}). Returning empty results to allow ungrounded response.`);
        return { chunks: [], citations: [] };
      }

      // Phase 4: Filter for high-relevance documents  
      const smartThreshold = parseFloat(process.env.SMART_RAG_THRESHOLD || '0.3');
      const allowAnswersQueryBypass = process.env.SMART_RAG_ALLOW_ANSWERS_BYPASS !== 'false';
      
      const relevantAnalyses = analyses.filter(a => 
        a.relevanceScore > smartThreshold || (allowAnswersQueryBypass && a.answersQuery)
      );

      console.log(`Smart RAG filtering: threshold=${smartThreshold}, allowAnswersQueryBypass=${allowAnswersQueryBypass}`);

      if (relevantAnalyses.length === 0) {
        console.log(`No documents above Smart RAG threshold ${smartThreshold} found, trying CQL fallback`);
        return await this.cqlFallback(query, filters, topK, model);
      }

      console.log(`Smart RAG found ${relevantAnalyses.length} documents above threshold ${smartThreshold}`);

      // Phase 5: Convert to chunks using extracted relevant sections
      const chunks = await this.analysesToChunks(query, relevantAnalyses, topK);
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
    // Extract key terms and drop filler words
    const stop = new Set(['what','how','the','can','you','help','with','need','all','my','being','have','has','had','every','each']);
    const tokens = query.toLowerCase()
      .replace(/[^a-z0-9\s-\.]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter(w => !stop.has(w))
      .map(w => w.replace(/\.+$/g, '')) // normalize trailing dots from draw.io
      .filter(w => w.length >= 3);

    // Prefer domain-relevant tokens for layout/alignment issues
    const prefer = new Set(['align','aligned','alignment','left','right','center','centre','diagram','diagrams','draw','drawio','drawio','confluence','jira']);
    const normalized = tokens.map(t => t === 'draw' ? 'drawio' : t);
    const preferred = normalized.filter(t => prefer.has(t) || /align/.test(t));
    const pool = preferred.length > 0 ? preferred : normalized;

    // Return up to 4 terms to give the server-side builder more signal
    return Array.from(new Set(pool)).slice(0, 4).join(' ');
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
    if (cveMatch) {entities.push(...cveMatch);}
    
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

    // Layout/Alignment-related
    if (/(align|aligned|alignment|left\s+aligned|right\s+aligned|center\s+aligned|centre\s+aligned|layout|formatting)/i.test(query)) {
      topics.push('alignment');
      topics.push('layout');
    }
    
    return topics;
  }

  /**
   * Convert analysis results to chunks, prioritizing relevant sections
   */
  private async analysesToChunks(
    query: string,
    analyses: any[], 
    topK: number
  ): Promise<any[]> {
    const chunks: any[] = [];

    // Helper: extract generic phrases (bigrams/trigrams) from query for scoring
    const extractPhrases = (text: string): string[] => {
      const stop = new Set(['the','a','an','to','of','for','and','or','but','if','then','else','with','without','on','in','at','by','from','as','is','are','was','were','be','been','being','i','you','we','they','he','she','it','my','our','your','their']);
      const tokens = text.toLowerCase()
        .replace(/[^a-z0-9\s-\.]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w.replace(/\.+$/g, ''));
      const filtered = tokens.filter(t => !stop.has(t) && t.length >= 2);
      const phrases: string[] = [];
      for (let i = 0; i < filtered.length - 1; i++) {
        phrases.push(`${filtered[i]} ${filtered[i+1]}`);
      }
      for (let i = 0; i < filtered.length - 2; i++) {
        phrases.push(`${filtered[i]} ${filtered[i+1]} ${filtered[i+2]}`);
      }
      // unique and keep up to 10
      return Array.from(new Set(phrases)).slice(0, 10);
    };

    // Helper: score a chunk generically (no domain hacks)
    const scoreChunk = (query: string, title: string, text: string): number => {
      const base = simpleTextRelevanceScore(query, text, title); // 0..1
      // Phrase match bonus
      const phrases = extractPhrases(query);
      const lower = text.toLowerCase();
      let phraseHits = 0;
      for (const p of phrases) {
        if (p.length >= 5 && lower.includes(p)) {phraseHits += 1;}
      }
      const phraseBonus = Math.min(0.3, phraseHits * 0.06);

      // Title/content mismatch penalty for generic categories (only if not in query)
      const qLower = query.toLowerCase();
      const tLower = (title || '').toLowerCase();
      const penaltyTerms = ['overview','licens','migration','support','pricing','billing','desk','contact','policy'];
      let penalty = 0;
      for (const term of penaltyTerms) {
        if (tLower.includes(term) && !qLower.includes(term)) {penalty += 0.08;}
      }
      penalty = Math.min(0.4, penalty);

      const finalScore = Math.max(0, Math.min(1, base + phraseBonus - penalty));
      return finalScore;
    };

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
        // Fall back to chunking the full document and pick best scoring chunks
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
        // Score chunks and select top 1-2
        const scored = docChunks.map(ch => ({ ch, score: scoreChunk(query, doc.title, ch.text) }))
          .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {chunks.push(scored[0].ch);}
        if (scored.length > 1 && chunks.length < topK) {chunks.push(scored[1].ch);}
      }
      
      if (chunks.length >= topK) {break;}
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

      // Apply relevance threshold from environment to CQL fallback results as well
      const envThreshold = isFinite(Number(process.env.RELEVANCE_THRESHOLD)) 
        ? Number(process.env.RELEVANCE_THRESHOLD) 
        : 0.2; // Much more permissive default for general questions
      const hasDirectMatch = response.documents.some(doc => {
        const queryLower = query.toLowerCase();
        const titleMatch = doc.title.toLowerCase().includes(queryLower);
        return titleMatch; // Simple heuristic for direct match in CQL fallback
      });

      if (!hasDirectMatch && envThreshold >= 0.4) { // Allow boundary case
        console.log(`CQL fallback: No direct matches found and threshold ${envThreshold} is high. Returning empty results.`);
        return { chunks: [], citations: [] };
      }
      
      // Chunking of fallback results with generic scoring
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
        const scored = docChunks.map(ch => ({ ch, score: simpleTextRelevanceScore(query, ch.text, ch.title) }))
          .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {chunks.push(scored[0].ch);}
        if (chunks.length >= topK) {break;}
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
    // Maintain 1:1 order with chunks so [n] maps to citations[n-1]
    const citations: Citation[] = [];

    for (const chunk of chunks) {
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
      const text: string = chunk.text || '';
      const snippet = text.length > 200 ? text.slice(0, 197) + '...' : text;

      citations.push({
        pageId: chunk.pageId,
        title: chunk.title,
        url,
        sectionAnchor: chunk.sectionAnchor,
        snippet
      });
    }

    return citations;
  }

  // Required by interface but not used in smart pipeline
  async indexDocument(document: DocumentSource): Promise<void> {
    // Not implemented - smart pipeline doesn't use local indexing
  }

  async deleteDocument(pageId: string): Promise<void> {
    // Not implemented - smart pipeline doesn't use local indexing  
  }
}
