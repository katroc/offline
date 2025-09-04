export interface EmbedOptions {
  baseUrl?: string; // default from env LLM_BASE_URL
  model?: string; // default from env LLM_EMBED_MODEL
  timeoutMs?: number; // default 15000
}

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = opts.model || process.env.LLM_EMBED_MODEL || 'gemma-3';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || 15000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`embeddings HTTP ${res.status}: ${text}`);
    }
    const data = (await res.json()) as any;
    const vecs: number[][] = data?.data?.map((d: any) => d?.embedding).filter(Array.isArray) || [];
    return vecs;
  } finally {
    clearTimeout(t);
  }
}

