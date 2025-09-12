import { chatCompletion, type ChatMessage } from '../llm/chat.js';
import type { DocumentSource } from '../sources/interfaces.js';
import { analysisCache, type CacheKey } from './analysis-cache.js';

// Analysis result interfaces
export interface AnalysisResult {
  document: DocumentSource;
  relevanceScore: number; // 0-1
  relevantSections: string[]; // Extracted relevant text chunks
  reasoning: string; // Why this document is relevant
  answersQuery: boolean; // Does this directly answer the question?
}

export interface RelevanceResult {
  document: DocumentSource;
  relevanceScore: number;
  explanation: string;
}

export interface ConversationContext {
  previousQueries: string[];
  topicContext: string[]; // Extracted topics from conversation
  entities: string[]; // Named entities mentioned
}

/**
 * Extracts JSON from LLM response that may be wrapped in markdown code blocks
 */
function extractJsonFromResponse(response: string): any {
  const trimmed = response.trim();
  
  // Try parsing directly first (for well-behaved responses)
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // If direct parsing fails, try extracting from markdown code blocks
  }

  // Look for JSON in markdown code blocks
  const codeBlockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;
  const match = trimmed.match(codeBlockRegex);
  
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (e) {
      console.warn('Failed to parse JSON from code block:', match[1]);
    }
  }

  // Look for JSON objects in the text (without code blocks)
  const jsonRegex = /(\{[\s\S]*\})/;
  const jsonMatch = trimmed.match(jsonRegex);
  
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch (e) {
      console.warn('Failed to parse JSON from raw text:', jsonMatch[1]);
    }
  }

  // If all else fails, return null
  console.warn('Could not extract JSON from LLM response:', trimmed.substring(0, 200));
  return null;
}

/**
 * Advanced document analysis with conversation context and caching.
 * Provides detailed analysis results with reasoning and section extraction.
 */
export class LLMDocumentAnalyzer {
  async extractConversationContext(conversationMemory: string, model?: string): Promise<ConversationContext> {
    if (!conversationMemory || conversationMemory.trim().length === 0) {
      return { previousQueries: [], topicContext: [], entities: [] };
    }

    try {
      const system: ChatMessage = {
        role: 'system',
        content: `You are an expert at analyzing conversation context. Extract key information from the conversation history.

Instructions:
1. Extract previous queries/questions the user has asked
2. Identify main topics and themes discussed
3. Extract named entities (people, places, products, concepts)

Respond with JSON in this exact format:
{
  "previousQueries": ["question 1", "question 2"],
  "topicContext": ["topic 1", "topic 2"],
  "entities": ["entity 1", "entity 2"]
}`
      };

      const user: ChatMessage = {
        role: 'user',
        content: `Conversation history: ${conversationMemory.substring(0, 2000)}`
      };

      const response = await chatCompletion([system, user], { model });
      const contextData = extractJsonFromResponse(response);
      
      if (!contextData) {
        return { previousQueries: [], topicContext: [], entities: [] };
      }

      return {
        previousQueries: Array.isArray(contextData.previousQueries) ? contextData.previousQueries : [],
        topicContext: Array.isArray(contextData.topicContext) ? contextData.topicContext : [],
        entities: Array.isArray(contextData.entities) ? contextData.entities : []
      };
    } catch (error) {
      console.error('Failed to extract conversation context:', error);
      return { previousQueries: [], topicContext: [], entities: [] };
    }
  }
  async analyzeDocuments(
    query: string,
    documents: DocumentSource[],
    topK: number = 5,
    context?: ConversationContext,
    model?: string
  ): Promise<AnalysisResult[]> {
    if (documents.length === 0) {return [];}

    // Analyze documents in parallel (with reasonable batch size)
    const batchSize = 3; // Analyze 3 docs at once to avoid overwhelming LLM
    const results: AnalysisResult[] = [];
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchPromises = batch.map(doc => this.analyzeSingleDocument(query, doc, context, model));
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        } else {
          console.warn(`Failed to analyze document ${batch[idx].id}:`, result.status === 'rejected' ? result.reason : 'Unknown error');
        }
      });
      
      // Stop if we have enough results
      if (results.length >= topK * 2) {break;}
    }

    // Sort by relevance and return top K
    return results
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);
  }

  private async analyzeSingleDocument(
    query: string,
    document: DocumentSource,
    context?: ConversationContext,
    model?: string
  ): Promise<AnalysisResult | null> {
    const cacheKey: CacheKey = {
      query,
      documentId: document.id,
      documentVersion: document.version || 1,
      contextHash: context ? this.hashContext(context) : 'no-context'
    };

    // Check cache first
    const cached = await analysisCache.get(cacheKey);
    if (cached) {
      return cached as AnalysisResult;
    }

    try {
      const contextPrompt = context ? this.buildContextPrompt(context) : '';
      
      const system: ChatMessage = {
        role: 'system',
        content: `You are a document analysis expert. Analyze the given document's relevance to the user's query.
${contextPrompt}

Instructions:
1. Score relevance from 0.0 (not relevant) to 1.0 (highly relevant)
2. Extract the most relevant text sections (max 3 sections, each under 200 chars)
3. Provide clear reasoning for the relevance score
4. Determine if this document directly answers the query

Respond with JSON in this exact format:
{
  "relevanceScore": 0.8,
  "relevantSections": ["section 1...", "section 2..."],
  "reasoning": "explanation...",
  "answersQuery": true
}`
      };

      const user: ChatMessage = {
        role: 'user', 
        content: `Query: "${query}"

Document to analyze:
Title: ${document.title}
Content: ${document.content.substring(0, 3000)}...

Analyze this document's relevance to the query.`
      };

      const response = await chatCompletion([system, user], { model });
      const analysisData = extractJsonFromResponse(response);
      
      if (!analysisData) {
        console.warn('Failed to parse analysis response for document:', document.id);
        return null;
      }

      const result: AnalysisResult = {
        document,
        relevanceScore: Math.max(0, Math.min(1, analysisData.relevanceScore || 0)),
        relevantSections: Array.isArray(analysisData.relevantSections) ? 
          analysisData.relevantSections.slice(0, 3) : [],
        reasoning: analysisData.reasoning || 'No reasoning provided',
        answersQuery: Boolean(analysisData.answersQuery)
      };

      // Cache the result
      await analysisCache.set(cacheKey, result);
      return result;
      
    } catch (error) {
      console.error('Document analysis failed:', error);
      return null;
    }
  }

  private buildContextPrompt(context: ConversationContext): string {
    let prompt = '';
    
    if (context.previousQueries.length > 0) {
      prompt += `\nPrevious queries in this conversation: ${context.previousQueries.join(', ')}`;
    }
    
    if (context.topicContext.length > 0) {
      prompt += `\nConversation topics: ${context.topicContext.join(', ')}`;
    }
    
    if (context.entities.length > 0) {
      prompt += `\nMentioned entities: ${context.entities.join(', ')}`;
    }
    
    if (prompt) {
      prompt = '\nConversation Context:' + prompt + '\n\nUse this context to better understand the user\'s intent.';
    }
    
    return prompt;
  }

  private hashContext(context: ConversationContext): string {
    const str = JSON.stringify({
      queries: context.previousQueries.sort(),
      topics: context.topicContext.sort(), 
      entities: context.entities.sort()
    });
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }
}

/**
 * Simple document ranking using LLM without advanced context analysis.
 * Faster and more suitable for basic ranking tasks.
 */
export async function rankDocumentsByRelevance(
  query: string,
  documents: DocumentSource[],
  topK: number = 5,
  model?: string
): Promise<RelevanceResult[]> {
  if (documents.length === 0) {return [];}

  // For large document sets, pre-filter to top candidates
  const candidates = documents.slice(0, 20); // Process max 20 at a time

  const system: ChatMessage = {
    role: 'system',
    content: `You are a document ranking system. Given a user query and a list of documents, rank them by relevance.

Instructions:
1. Score each document from 0.0 (not relevant) to 1.0 (highly relevant)
2. Provide a brief explanation for each score
3. Consider the document title and content

Respond with JSON array in this format:
[
  {"id": "doc-1", "relevanceScore": 0.8, "explanation": "reason..."},
  {"id": "doc-2", "relevanceScore": 0.3, "explanation": "reason..."}
]

Sort by relevance score (highest first).`
  };

  const docSummaries = candidates.map(doc => 
    `ID: ${doc.id}
Title: ${doc.title}
Content: ${doc.content.substring(0, 500)}...
`).join('\n---\n');

  const user: ChatMessage = {
    role: 'user',
    content: `Query: "${query}"

Documents to rank:
${docSummaries}`
  };

  try {
    const response = await chatCompletion([system, user], { model });
    const rankings = extractJsonFromResponse(response);
    
    if (!Array.isArray(rankings)) {
      console.warn('Invalid ranking response format, falling back to keyword scoring');
      return fallbackKeywordRanking(query, candidates, topK);
    }

    const results: RelevanceResult[] = rankings
      .map((ranking: any) => {
        const doc = candidates.find(d => d.id === ranking.id);
        if (!doc) {return null;}
        
        return {
          document: doc,
          relevanceScore: Math.max(0, Math.min(1, ranking.relevanceScore || 0)),
          explanation: ranking.explanation || 'No explanation provided'
        };
      })
      .filter((r): r is RelevanceResult => r !== null)
      .slice(0, topK);

    return results;

  } catch (error) {
    console.error('LLM ranking failed, falling back to keyword scoring:', error);
    return fallbackKeywordRanking(query, candidates, topK);
  }
}

/**
 * Fallback keyword-based scoring when LLM analysis fails
 */
function fallbackKeywordRanking(
  query: string, 
  documents: DocumentSource[], 
  topK: number
): RelevanceResult[] {
  return documents
    .map(doc => ({
      document: doc,
      relevanceScore: simpleTextRelevanceScore(query, doc.content, doc.title),
      explanation: 'Keyword-based fallback scoring'
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topK);
}

/**
 * Simple text relevance scoring based on keyword matching
 */
export function simpleTextRelevanceScore(query: string, text: string, title?: string): number {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const titleLower = title?.toLowerCase() || '';
  
  let score = 0;
  
  // Title matches are worth more
  if (titleLower && titleLower.includes(queryLower)) {score += 0.5;}
  
  // Count keyword occurrences in content
  const queryWords = queryLower.split(/\s+/);
  let wordMatches = 0;
  
  for (const word of queryWords) {
    if (word.length > 2) { // Skip very short words
      const occurrences = (textLower.match(new RegExp(word, 'g')) || []).length;
      wordMatches += Math.min(occurrences, 5); // Cap at 5 per word
    }
  }
  
  // Normalize score
  score += (wordMatches / (queryWords.length * 5)) * 0.5;
  
  return Math.min(1, score);
}

/**
 * Helper function for keyword-based document scoring (internal use)
 */
function calculateKeywordScore(query: string, doc: DocumentSource): number {
  const queryLower = query.toLowerCase();
  const titleLower = doc.title.toLowerCase();
  const textLower = doc.content.toLowerCase();
  
  let score = 0;
  
  // Title matches are worth more
  if (titleLower.includes(queryLower)) {score += 0.5;}
  
  // Count keyword occurrences in content
  const queryWords = queryLower.split(/\s+/);
  let wordMatches = 0;
  
  for (const word of queryWords) {
    if (word.length > 2) {
      const titleMatches = (titleLower.match(new RegExp(word, 'g')) || []).length;
      const contentMatches = (textLower.match(new RegExp(word, 'g')) || []).length;
      
      wordMatches += titleMatches * 2; // Title words worth double
      wordMatches += Math.min(contentMatches, 3); // Cap content matches
    }
  }
  
  score += (wordMatches / (queryWords.length * 5)) * 0.5;
  
  return Math.min(1, score);
}