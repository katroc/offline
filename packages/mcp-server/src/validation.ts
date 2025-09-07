export interface ValidRagQuery {
  question: string;
  space?: string;
  labels?: string[];
  updatedAfter?: string;
  topK: number; // defaulted to 5
  model?: string; // optional model override
  conversationId?: string; // optional conversation/thread id
  ragBypass?: boolean; // optional flag to bypass RAG and use direct LLM interaction
}

export function validateRagQuery(input: unknown): { ok: true; value: ValidRagQuery } | { ok: false; error: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const question = typeof obj.question === 'string' ? obj.question.trim() : '';
  if (!question) return { ok: false, error: 'invalid request: missing question' };

  const space = typeof obj.space === 'string' ? obj.space : undefined;
  let labels: string[] | undefined;
  if (Array.isArray(obj.labels)) {
    const filtered = obj.labels.filter((l: unknown): l is string => typeof l === 'string');
    labels = filtered.length ? filtered : undefined;
  }
  const updatedAfter = typeof obj.updatedAfter === 'string' ? obj.updatedAfter : undefined;
  const rawTopK = Number((obj as any).topK);
  const topK = Number.isFinite(rawTopK) ? Math.max(1, Math.min(100, rawTopK)) : 5;
  const model = typeof obj.model === 'string' ? obj.model.trim() : undefined;
  const conversationId = typeof (obj as any).conversationId === 'string' ? String((obj as any).conversationId) : undefined;
  const ragBypass = typeof (obj as any).ragBypass === 'boolean' ? (obj as any).ragBypass : undefined;

  // Optional: ISO date sanity
  if (updatedAfter && isNaN(Date.parse(updatedAfter))) {
    return { ok: false, error: 'invalid updatedAfter: must be ISO8601 date string' };
  }

  return { ok: true, value: { question, space, labels, updatedAfter, topK, model, conversationId, ragBypass } };
}
