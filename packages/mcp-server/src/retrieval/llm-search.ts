import { chatCompletion, type ChatMessage } from '../llm/chat.js';
import type { DocumentSource } from '../sources/interfaces.js';

export interface RelevanceResult {
  document: DocumentSource;
  relevanceScore: number;
  explanation: string;
}

/**
 * Use the LLM to rank documents by relevance to a query
 * This replaces embedding-based similarity search
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
2. Consider semantic similarity, not just keyword matching
3. Return ONLY a JSON array with this format:
[
  {"id": "doc_id", "score": 0.95, "reason": "brief explanation"},
  {"id": "doc_id", "score": 0.7, "reason": "brief explanation"}
]

Do not include any other text or explanation.`
  };

  // Build document summaries for ranking
  const docSummaries = candidates.map(doc => 
    `ID: ${doc.id}\nTitle: ${doc.title}\nContent: ${doc.content.substring(0, 500)}...`
  ).join('\n\n---\n\n');

  const user: ChatMessage = {
    role: 'user',
    content: `Query: "${query}"

Documents to rank:
${docSummaries}`
  };

  try {
    const response = await chatCompletion([system, user], { 
      model,
      temperature: 0.1, // Low temperature for consistent ranking
      maxTokens: 1000 
    });

    // Parse LLM response
    const rankings = JSON.parse(response.trim());
    
    // Match rankings back to documents and sort
    const results: RelevanceResult[] = rankings
      .map((ranking: any) => {
        const doc = candidates.find(d => d.id === ranking.id);
        if (!doc) {return null;}
        
        return {
          document: doc,
          relevanceScore: ranking.score,
          explanation: ranking.reason || 'No explanation provided'
        };
      })
      .filter((result: any) => result !== null)
      .sort((a: RelevanceResult, b: RelevanceResult) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);

    return results;

  } catch (error) {
    console.warn('LLM-based ranking failed, falling back to keyword ranking:', error);
    
    // Fallback: simple keyword-based scoring
    return candidates
      .map(doc => ({
        document: doc,
        relevanceScore: calculateKeywordScore(query, doc),
        explanation: 'Keyword-based fallback scoring'
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, topK);
  }
}

/**
 * Simple keyword-based relevance scoring as fallback
 */
export function simpleTextRelevanceScore(query: string, text: string, title?: string): number {
  const queryLower = query.toLowerCase();
  const titleLower = (title || '').toLowerCase();
  const contentLower = text.toLowerCase();
  
  let score = 0;
  
  // Title matches are worth more
  if (titleLower && titleLower.includes(queryLower)) {score += 0.5;}
  
  // Count keyword occurrences in content
  const queryWords = queryLower.split(/\s+/);
  for (const word of queryWords) {
    if (word.length > 2) { // Skip very short words
      const titleMatches = titleLower ? (titleLower.match(new RegExp(word, 'g')) || []).length : 0;
      const contentMatches = (contentLower.match(new RegExp(word, 'g')) || []).length;
      score += titleMatches * 0.1 + contentMatches * 0.02;
    }
  }
  
  return Math.min(score, 1.0); // Cap at 1.0
}

function calculateKeywordScore(query: string, doc: DocumentSource): number {
  const queryLower = query.toLowerCase();
  const titleLower = doc.title.toLowerCase();
  const contentLower = doc.content.toLowerCase();
  
  let score = 0;
  
  // Title matches are worth more
  if (titleLower.includes(queryLower)) {score += 0.5;}
  
  // Count keyword occurrences in content
  const queryWords = queryLower.split(/\s+/);
  for (const word of queryWords) {
    if (word.length > 2) { // Skip very short words
      const titleMatches = (titleLower.match(new RegExp(word, 'g')) || []).length;
      const contentMatches = (contentLower.match(new RegExp(word, 'g')) || []).length;
      score += titleMatches * 0.1 + contentMatches * 0.02;
    }
  }
  
  return Math.min(score, 1.0); // Cap at 1.0
}
