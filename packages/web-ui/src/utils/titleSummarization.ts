interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Generate a concise, meaningful title for a conversation based on its messages
 */
// Smart trim a string without cutting words; adds ellipsis when trimmed
function smartTrim(input: string, maxChars: number): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars + 1);
  const lastSpace = slice.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? slice.slice(0, lastSpace) : clean.slice(0, maxChars);
  return trimmed.replace(/[\s,;:.-]+$/, '') + '…';
}

function normalizeTitle(title: string, maxChars = 80): string {
  let t = title
    .replace(/^<\|start\|>|<\|end\|>$/g, '')
    .replace(/^["']|["']$/g, '')
    .replace(/^Title:\s*/i, '')
    .replace(/^Here'?s.*?:\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  // Keep it succinct by words first
  const words = t.split(' ');
  if (words.length > 12) {
    t = words.slice(0, 12).join(' ');
  }
  // Final guard by characters with smart trimming
  return smartTrim(t, maxChars);
}

import { stripThinking } from './thinking';

export async function generateConversationTitle(messages: Message[], model?: string): Promise<string> {
  if (!messages || messages.length === 0) {
    return 'New conversation';
  }

  // If there's only a user message, use first 50 characters as before
  if (messages.length === 1) {
    return messages[0].content.trim().slice(0, 50) + (messages[0].content.length > 50 ? '...' : '');
  }

  // For conversations with at least one exchange, generate a smart title
  try {
    // Get the first few messages (user question + assistant response + maybe one more exchange)
    const contextMessages = messages.slice(0, Math.min(4, messages.length));
    
    // Build context string
    const conversationContext = contextMessages
      .map(msg => `${msg.type === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');

    const prompt = `You are a helpful assistant that creates short, descriptive titles.

Conversation:
${conversationContext}

Create a short title that summarizes this conversation.
- Length: 3–8 words and under 80 characters
- No punctuation at the end
- Respond with only the title (no quotes, no prefixes)`;

    const requestBody = {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 100,
      ...(model && model.trim() && { model: model }), // Only include model if it's not empty
    };
    
    const response = await fetch('/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();

    // Try multiple common provider fields for the title content
    const candidates: Array<unknown> = [
      result?.choices?.[0]?.message?.content,
      // Some providers put suggested output in a non-standard reasoning field
      result?.choices?.[0]?.message?.reasoning,
      // OpenAI text completion–style
      result?.choices?.[0]?.text,
      // Other compatibility layers
      result?.output_text,
    ];

    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) {
        const title = normalizeTitle(stripThinking(c));
        if (title) return title;
      }
    }

    // Fallback to first message if AI generation is empty
    return smartTrim(messages[0].content, 60);
    
  } catch (error) {
    console.warn('Failed to generate conversation title:', error);
    // Fallback to first message
    return smartTrim(messages[0].content, 60);
  }
}

/**
 * Determine if a conversation should get an auto-generated title
 */
export function shouldUpdateTitle(title: string, messageCount: number, firstUserMessage?: string): boolean {
  // Update if it's still the default title and we have at least one exchange
  if ((title === 'New conversation') && messageCount >= 2) {
    return true;
  }
  
  // Update if the title is just the truncated first message (from the old logic)
  if (firstUserMessage && messageCount >= 2) {
    const truncated = firstUserMessage.slice(0, 60);
    if (title === truncated || title === truncated + '...') {
      return true;
    }
  }
  
  // Update if title ends with '...' (indicating it was auto-generated)
  if (title.endsWith('...') && messageCount >= 2) {
    return true;
  }
  
  // Don't update if user has likely customized the title
  return false;
}
