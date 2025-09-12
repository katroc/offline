export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  baseUrl?: string; // default from env LLM_BASE_URL
  model?: string; // default from env LLM_CHAT_MODEL
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number; // default 15000
}

export async function chatCompletion(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = opts.model || process.env.LLM_CHAT_MODEL || 'gemma-3';
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 512;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || 15000);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chat HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as any;
    const choice = data?.choices?.[0] ?? {};
    const msg = choice?.message ?? {};
    const content: string = typeof msg?.content === 'string' ? msg.content : '';

    // Some providers return reasoning in a separate field — surface it as <think>…</think>
    const possibleReasoning: unknown[] = [
      msg?.reasoning,
      choice?.reasoning,
      msg?.thinking,
      choice?.thinking,
      // Some adapters use nonstandard fields
      msg?.metadata?.reasoning,
      msg?.metadata?.thinking,
    ];

    let reasoning = '';
    for (const r of possibleReasoning) {
      if (typeof r === 'string' && r.trim()) { reasoning = r.trim(); break; }
    }

    // If content already includes a <think> block, return as-is
    if (typeof content === 'string' && /<think[\s>]/i.test(content)) {
      return content;
    }

    // Otherwise, prepend reasoning when present
    if (reasoning) {
      const think = `<think>\n${reasoning}\n</think>\n\n`;
      return think + (content || '');
    }

    if (!content) {throw new Error('invalid chat response');}
    return content;
  } finally {
    clearTimeout(t);
  }
}

export async function* chatCompletionStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string, void, unknown> {
  const baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = opts.model || process.env.LLM_CHAT_MODEL || 'gemma-3';
  const temperature = opts.temperature ?? 0.2;
  const maxTokens = opts.maxTokens ?? 512;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || 15000);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 
        model, 
        temperature, 
        max_tokens: maxTokens, 
        messages,
        stream: true 
      }),
      signal: controller.signal,
    });
    
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chat HTTP ${res.status}: ${text}`);
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('No readable stream');
    }

    let thinkOpen = false;
    let sawContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {return;}
          
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta ?? {};
            const r = typeof delta?.reasoning === 'string' ? delta.reasoning : '';
            const c = typeof delta?.content === 'string' ? delta.content : '';

            if (r && !thinkOpen && !sawContent) {
              // Open think block if reasoning starts before any content
              thinkOpen = true;
              yield '<think>';
            }
            if (r) {
              yield r;
            }
            if (c) {
              if (thinkOpen) {
                // Close think block on first content piece
                thinkOpen = false;
                yield '</think>\n\n';
              }
              sawContent = true;
              yield c;
            }
          } catch (e) {
            // Skip malformed JSON
            continue;
          }
        }
      }
    }
  } finally {
    clearTimeout(t);
  }
}
