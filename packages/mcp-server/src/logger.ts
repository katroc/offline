import { randomUUID } from 'node:crypto';

type Level = 'info' | 'error' | 'warn' | 'debug';

interface BaseLog {
  level: Level;
  ts: string;
  msg: string;
  reqId?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  err?: { name?: string; message?: string; stack?: string };
}

export function generateRequestId(): string {
  try {
    return randomUUID();
  } catch {
    // Fallback if randomUUID not available
    return Math.random().toString(36).slice(2);
  }
}

function write(log: BaseLog) {
   
  console.log(JSON.stringify(log));
}

export function logRequestStart({ reqId, method, url }: { reqId: string; method: string; url: string }) {
  write({ level: 'info', ts: new Date().toISOString(), msg: 'request.start', reqId, method, url });
}

export function logRequestEnd({
  reqId,
  method,
  url,
  status,
  startedAt,
}: {
  reqId: string;
  method: string;
  url: string;
  status: number;
  startedAt: number;
}) {
  const durationMs = Date.now() - startedAt;
  write({ level: 'info', ts: new Date().toISOString(), msg: 'request.end', reqId, method, url, status, durationMs });
}

export function logError({ reqId, method, url, err }: { reqId?: string; method?: string; url?: string; err: unknown }) {
  const anyErr = err as any;
  write({
    level: 'error',
    ts: new Date().toISOString(),
    msg: 'error',
    reqId,
    method,
    url,
    err: {
      name: anyErr?.name,
      message: anyErr?.message || String(anyErr),
      stack: anyErr?.stack,
    },
  });
}

