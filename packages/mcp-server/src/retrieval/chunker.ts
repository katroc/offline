import type { Chunk, ConfluencePage } from '@app/shared';
import { randomUUID } from 'crypto';

export interface ChunkingConfig {
  targetChunkSize: number; // tokens
  overlap: number; // tokens
  maxChunkSize: number; // tokens
}

export interface Chunker {
  chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]>;
}

export class SimpleChunker implements Chunker {
  constructor(private config: ChunkingConfig) {}

  async chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]> {
    // Strip HTML and get plain text
    const plainText = this.htmlToText(content);
    
    // Split by headings first, then by token count
    const sections = this.extractSections(plainText);
    const chunks: Chunk[] = [];
    
    for (const section of sections) {
      const sectionChunks = await this.chunkSection(page, section);
      chunks.push(...sectionChunks);
    }
    
    return chunks;
  }

  private htmlToText(html: string): string {
    // Basic HTML stripping - could be enhanced with proper parser
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractSections(text: string): Array<{text: string, anchor?: string}> {
    // Simple section extraction - split on common heading patterns
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    const sections: Array<{text: string, anchor?: string}> = [];
    let currentSection = '';
    let currentAnchor: string | undefined;

    for (const line of lines) {
      // Detect heading patterns (this is basic - could be improved)
      const isHeading = line.length < 100 && (
        line.match(/^[A-Z][^.]*$/) || // All caps or title case
        line.match(/^\d+\./) || // Numbered heading
        line.endsWith(':') // Ends with colon
      );

      if (isHeading && currentSection.length > 200) {
        // Save previous section
        sections.push({ 
          text: currentSection.trim(), 
          anchor: currentAnchor 
        });
        currentSection = line + '\n';
        currentAnchor = this.textToAnchor(line);
      } else {
        currentSection += line + '\n';
      }
    }

    // Add final section
    if (currentSection.trim()) {
      sections.push({ 
        text: currentSection.trim(), 
        anchor: currentAnchor 
      });
    }

    return sections.length > 0 ? sections : [{ text }];
  }

  private async chunkSection(
    page: ConfluencePage, 
    section: {text: string, anchor?: string}
  ): Promise<Chunk[]> {
    const tokens = this.estimateTokens(section.text);
    
    if (tokens <= this.config.targetChunkSize) {
      // Section fits in one chunk
      return [{
        id: randomUUID(),
        pageId: page.id,
        space: page.spaceKey,
        title: page.title,
        sectionAnchor: section.anchor,
        text: section.text,
        version: page.version,
        updatedAt: page.updatedAt,
        labels: page.labels,
        url: page.url
      }];
    }

    // Split large section into overlapping chunks
    const chunks: Chunk[] = [];
    const words = section.text.split(/\s+/);
    const wordsPerChunk = Math.floor(this.config.targetChunkSize / 4); // Rough estimate
    const overlapWords = Math.floor(this.config.overlap / 4);

    for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
      const chunkWords = words.slice(i, i + wordsPerChunk);
      if (chunkWords.length === 0) break;

      const chunkText = chunkWords.join(' ');
      chunks.push({
        id: randomUUID(),
        pageId: page.id,
        space: page.spaceKey,
        title: page.title,
        sectionAnchor: section.anchor,
        text: chunkText,
        version: page.version,
        updatedAt: page.updatedAt,
        labels: page.labels,
        url: page.url
      });

      // Prevent infinite loop
      if (i + wordsPerChunk >= words.length) break;
    }

    return chunks;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
  }

  private textToAnchor(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }
}
