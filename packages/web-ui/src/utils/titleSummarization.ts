interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Generate a concise, meaningful title for a conversation based on its messages
 */
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

Create a short title (3-6 words) that summarizes this conversation. Respond with only the title, no special tokens or formatting:`;

    const requestBody = {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7, // Increase temperature for more creative responses
      max_tokens: 50,   // Increase token limit to give more room
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
    let title = result.choices?.[0]?.message?.content?.trim();
    
    if (title && title.length > 0) {
      // Clean up model-specific tokens and formatting
      title = title
        .replace(/^<\|start\|>|<\|end\|>$/g, '') // Remove model tokens
        .replace(/^["']|["']$/g, '') // Remove surrounding quotes
        .replace(/\.$/, '') // Remove trailing period
        .replace(/^Title:\s*/i, '') // Remove "Title:" prefix
        .replace(/^Here's.*?:\s*/i, '') // Remove "Here's a title:" type prefixes
        .trim();
      
      if (title && title.length > 0 && title.length <= 100) {
        return title;
      }
    }
    
    // Fallback to first message if AI generation fails
    return messages[0].content.trim().slice(0, 50) + (messages[0].content.length > 50 ? '...' : '');
    
  } catch (error) {
    console.warn('Failed to generate conversation title:', error);
    // Fallback to first message
    return messages[0].content.trim().slice(0, 50) + (messages[0].content.length > 50 ? '...' : '');
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