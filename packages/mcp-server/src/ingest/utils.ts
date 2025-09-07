import crypto from 'node:crypto';

export function normalizeHtml(html: string): string {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Simple semaphore to limit concurrency without extra deps
export class Semaphore {
  private queue: Array<() => void> = [];
  private current = 0;
  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.limit) {
      this.current++;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class RateLimiter {
  private nextAllowed = 0;
  constructor(private readonly minIntervalMs: number) {}
  async waitTurn(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAllowed - now);
    if (wait > 0) await new Promise(res => setTimeout(res, wait));
    this.nextAllowed = Date.now() + Math.max(0, this.minIntervalMs);
  }
}
