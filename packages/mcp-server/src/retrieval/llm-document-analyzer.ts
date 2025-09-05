import { chatCompletion, type ChatMessage } from '../llm/chat.js';
import type { DocumentSource } from '../sources/interfaces.js';
import { analysisCache, type CacheKey } from './analysis-cache.js';

export interface AnalysisResult {
  document: DocumentSource;
  relevanceScore: number; // 0-1
  relevantSections: string[]; // Extracted relevant text chunks
  reasoning: string; // Why this document is relevant
  answersQuery: boolean; // Does this directly answer the question?
}

export interface ConversationContext {
  previousQueries: string[];
  topicContext: string[]; // Extracted topics from conversation
  entities: string[]; // Named entities mentioned
}

/**
 * Uses LLM to analyze documents for relevance to user queries
 * Much smarter than keyword matching
 */
export class LLMDocumentAnalyzer {
  
  /**
   * Analyze a batch of documents against a query with conversation context
   */
  async analyzeDocuments(
    query: string, 
    documents: DocumentSource[], 
    context?: ConversationContext,
    model?: string
  ): Promise<AnalysisResult[]> {
    if (documents.length === 0) return [];

    // Analyze documents in parallel (with reasonable batch size)
    const batchSize = 3; // Analyze 3 docs at once to avoid overwhelming LLM
    const results: AnalysisResult[] = [];
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(doc => this.analyzeSingleDocument(query, doc, context, model))
      );
      results.push(...batchResults);
    }

    // Sort by relevance score (highest first)
    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Analyze a single document for relevance
   */
  private async analyzeSingleDocument(
    query: string, 
    document: DocumentSource, 
    context?: ConversationContext,
    model?: string
  ): Promise<AnalysisResult> {
    
    // Check cache first
    const contextHash = context 
      ? analysisCache.hashContext(context.topicContext, context.entities, context.previousQueries)
      : 'no-context';
    
    const cacheKey: CacheKey = {
      documentId: document.id,
      documentVersion: document.version,
      query: query.trim().toLowerCase(),
      contextHash
    };
    
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      console.log(`Cache hit for document ${document.id}`);
      return cached;
    }
    
    const contextInfo = context ? this.buildContextString(context) : '';
    
    const system: ChatMessage = {
      role: 'system',
      content: `You are a document relevance analyzer. Your job is to:
1. Read the full document content
2. Determine how relevant it is to answering the user's question
3. Extract the most relevant sections if any
4. Provide a relevance score from 0.0 to 1.0
5. Explain your reasoning

Consider conversation context if provided. Be precise and analytical.

Respond ONLY in this JSON format:
{
  "relevanceScore": 0.8,
  "answersQuery": true,
  "relevantSections": ["specific text from doc that's relevant"],
  "reasoning": "Brief explanation of why this document is/isn't relevant"
}`
    };

    // Truncate very long documents to avoid token limits
    const maxLength = 8000; // Reasonable chunk size
    const truncatedContent = document.content.length > maxLength 
      ? document.content.substring(0, maxLength) + '\n... [TRUNCATED]'
      : document.content;

    const user: ChatMessage = {
      role: 'user',
      content: `Query: "${query}"

${contextInfo}

Document to analyze:
Title: ${document.title}
Space: ${document.spaceKey}
Content: ${truncatedContent}

Analyze this document's relevance to the query.`
    };

    try {
      const response = await chatCompletion([system, user], { 
        model,
        temperature: 0.1, // Low temperature for consistent analysis
        maxTokens: 500 
      });
      
      const analysis = JSON.parse(response.trim());
      
      const result: AnalysisResult = {
        document,
        relevanceScore: Math.max(0, Math.min(1, analysis.relevanceScore || 0)),
        relevantSections: Array.isArray(analysis.relevantSections) ? analysis.relevantSections : [],
        reasoning: analysis.reasoning || 'No reasoning provided',
        answersQuery: Boolean(analysis.answersQuery)
      };
      
      // Cache the result
      analysisCache.set(cacheKey, result);
      console.log(`Cached analysis for document ${document.id}`);
      
      return result;
      
    } catch (error) {
      console.warn(`Document analysis failed for ${document.id}:`, error);
      
      // Fallback to simple keyword matching
      const queryLower = query.toLowerCase();
      const titleLower = document.title.toLowerCase();
      const contentLower = document.content.toLowerCase();
      
      const titleMatch = titleLower.includes(queryLower);
      const contentMatch = contentLower.includes(queryLower);
      
      return {
        document,
        relevanceScore: titleMatch ? 0.6 : (contentMatch ? 0.3 : 0.1),
        relevantSections: [],
        reasoning: `Fallback analysis: ${titleMatch ? 'title match' : contentMatch ? 'content match' : 'no clear match'}`,
        answersQuery: titleMatch || contentMatch
      };
    }
  }

  /**
   * Build context string from conversation history
   */
  private buildContextString(context: ConversationContext): string {
    const parts: string[] = [];
    
    if (context.previousQueries.length > 0) {
      parts.push(`Previous questions: ${context.previousQueries.slice(-3).join(', ')}`);
    }
    
    if (context.topicContext.length > 0) {
      parts.push(`Topic context: ${context.topicContext.join(', ')}`);
    }
    
    if (context.entities.length > 0) {
      parts.push(`Key entities: ${context.entities.join(', ')}`);
    }
    
    return parts.length > 0 ? `\nConversation context:\n${parts.join('\n')}\n` : '';
  }

  /**
   * Extract conversation context from query history
   */
  async extractConversationContext(queries: string[], model?: string): Promise<ConversationContext> {
    if (queries.length === 0) {
      return { previousQueries: [], topicContext: [], entities: [] };
    }

    const system: ChatMessage = {
      role: 'system',
      content: `Extract conversation context from these queries. Identify:
1. Key topics/themes
2. Named entities (products, CVEs, technical terms, etc.)
3. Evolving context (how questions relate to each other)

Respond in JSON format:
{
  "topicContext": ["security", "configuration"],
  "entities": ["CVE-2022-22965", "draw.io", "Spring Framework"]
}`
    };

    const user: ChatMessage = {
      role: 'user', 
      content: `Query history:\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    };

    try {
      const response = await chatCompletion([system, user], { 
        model,
        temperature: 0.2,
        maxTokens: 300 
      });
      
      const context = JSON.parse(response.trim());
      
      return {
        previousQueries: queries,
        topicContext: Array.isArray(context.topicContext) ? context.topicContext : [],
        entities: Array.isArray(context.entities) ? context.entities : []
      };
      
    } catch (error) {
      console.warn('Context extraction failed:', error);
      return { previousQueries: queries, topicContext: [], entities: [] };
    }
  }
}