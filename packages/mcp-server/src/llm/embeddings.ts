export interface EmbedOptions {
  baseUrl?: string; // default from env LLM_BASE_URL
  model?: string; // default from env LLM_EMBED_MODEL
  timeoutMs?: number; // default 15000
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {return [];}
  
  const baseUrl = opts.baseUrl || process.env.LLM_BASE_URL || 'http://127.0.0.1:1234';
  const model = opts.model || process.env.LLM_EMBED_MODEL || 'text-embedding-embeddinggemma-300m-qat';
  const timeoutMs = opts.timeoutMs ?? Number(process.env.REQUEST_TIMEOUT_MS || 15000);
  const maxRetries = Math.max(0, Number(process.env.EMBED_MAX_RETRIES || 3));
  const baseDelay = Math.max(0, Number(process.env.EMBED_BACKOFF_BASE_MS || 250));
  
  console.log(`Attempting embeddings with model: ${model}`);
  let attempt = 0;
  while (true) {
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
        const isRetryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (isRetryable && attempt < maxRetries) {
          const ra = res.headers.get('retry-after');
          const raMs = ra ? (Number(ra) * 1000 || 0) : 0;
          const delay = Math.max(raMs, baseDelay * Math.pow(2, attempt)) + Math.floor(Math.random() * 100);
          console.warn(`Embeddings retry ${attempt + 1}/${maxRetries} after HTTP ${res.status}. Waiting ${delay}ms`);
          attempt++;
          await sleep(delay);
          continue;
        }
        throw new Error(`embeddings HTTP ${res.status}: ${text}`);
      }
      const data = (await res.json()) as any;
      const vecs: number[][] = data?.data?.map((d: any) => d?.embedding).filter(Array.isArray) || [];
      return vecs;
    } finally {
      clearTimeout(t);
    }
  }
}
