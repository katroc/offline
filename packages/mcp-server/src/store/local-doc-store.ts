import type { DocumentSource, SearchParams } from '../sources/interfaces.js';

export class LocalDocStore {
  private docs: Map<string, DocumentSource> = new Map();

  upsertAll(documents: DocumentSource[]): void {
    for (const d of documents) this.docs.set(d.id, d);
  }

  size(): number { return this.docs.size; }

  // Simple candidate selection without CQL: naive term scoring over title + content
  queryCandidates(query: string, filters: Omit<SearchParams, 'query'>, limit = 30): DocumentSource[] {
    const terms = this.tokenize(query);
    if (terms.length === 0) return [];

    const candidates: Array<{ doc: DocumentSource; score: number }> = [];
    for (const doc of this.docs.values()) {
      if (filters.space && doc.spaceKey !== filters.space) continue;
      if (filters.labels && filters.labels.length > 0) {
        const hasAny = filters.labels.some(l => doc.labels.includes(l));
        if (!hasAny) continue;
      }
      if (filters.updatedAfter && new Date(doc.updatedAt) < new Date(filters.updatedAfter)) continue;

      const hay = `${doc.title}\n${this.stripHtml(doc.content)}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        // count occurrences crudely
        const matches = hay.split(t).length - 1;
        score += matches * (t.length >= 5 ? 2 : 1);
      }
      if (score > 0) candidates.push({ doc, score });
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.doc);
  }

  private tokenize(q: string): string[] {
    const stop = new Set(['how','do','i','use','what','is','the','a','an','to','of','for','about','tell','me']);
    return Array.from(new Set(
      q.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
        .filter(Boolean)
        .filter(w => !stop.has(w))
        .map(w => w.trim())
        .filter(w => w.length >= 3)
    ));
  }

  private stripHtml(html: string): string {
    return html.replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ');
  }
}

