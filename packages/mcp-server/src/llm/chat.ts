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
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('invalid chat response');
    return content;
  } finally {
    clearTimeout(t);
  }
}

