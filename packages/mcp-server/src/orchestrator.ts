import type { RagResponse, Citation } from '@app/shared';
import type { ValidRagQuery } from './validation.js';
import { chatCompletion, type ChatMessage } from './llm/chat.js';

export async function ragQuery(query: ValidRagQuery): Promise<RagResponse> {
  // Mock citations for now; retrieval pipeline to replace these
  const baseUrl = 'https://confluence.local/pages';
  const citations: Citation[] = [
    { pageId: '12345', title: 'Getting Started', url: `${baseUrl}/12345`, sectionAnchor: 'introduction' },
    { pageId: '67890', title: 'Architecture Overview', url: `${baseUrl}/67890`, sectionAnchor: 'rag-pipeline' },
  ];

  const useLlm = (process.env.LLM_BASE_URL || '').length > 0;
  if (!useLlm) {
    return { answer: `Stubbed answer for: ${query.question}`, citations };
  }

  const system: ChatMessage = {
    role: 'system',
    content:
      'You are a Confluence-only assistant. Answer concisely and include factual details. If unsure, say you do not know.',
  };
  const contextLines = citations
    .map((c) => `- ${c.title} (${c.url}${c.sectionAnchor ? '#' + c.sectionAnchor : ''})`)
    .join('\n');
  const user: ChatMessage = {
    role: 'user',
    content: `Question: ${query.question}\n\nKnown sources (may be partial during development):\n${contextLines}`,
  };

  try {
    const answer = await chatCompletion([system, user]);
    return { answer, citations };
  } catch (err) {
    // Fallback to stubbed answer if LLM call fails
    return { answer: `Stubbed answer for: ${query.question}`, citations };
  }
}
