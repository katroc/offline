import type { Chunk, ConfluencePage } from '@app/shared';
import { randomUUID } from 'crypto';
import type { ChunkingConfig } from './chunker.js';

export interface SemanticChunkingConfig extends ChunkingConfig {
  semanticThreshold: number; // 0.0-1.0, similarity threshold for semantic boundaries
  preserveStructure: boolean; // Keep HTML structure info
  minChunkWords: number; // Minimum words per chunk
  maxChunkWords: number; // Maximum words per chunk
  contextWindow: number; // Words of context to include around chunk
  enableHierarchical: boolean; // Create parent-child relationships
}

export interface DocumentStructure {
  headings: Array<{
    level: number;
    text: string;
    anchor: string;
    startPos: number;
    endPos: number;
  }>;
  sections: Array<{
    heading?: string;
    level: number;
    content: string;
    startPos: number;
    endPos: number;
    anchor?: string;
  }>;
  metadata: {
    hasLists: boolean;
    hasCode: boolean;
    hasTables: boolean;
    hasImages: boolean;
  };
}

export class SemanticChunker {
  constructor(private config: SemanticChunkingConfig) {}

  async chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]> {
    // Parse document structure
    const structure = this.parseDocumentStructure(content);
    
    // Create chunks with semantic boundaries
    const chunks = await this.createSemanticChunks(page, structure);
    
    // Add hierarchical relationships if enabled
    if (this.config.enableHierarchical) {
      return this.addHierarchicalRelationships(chunks, structure);
    }
    
    return chunks;
  }

  private parseDocumentStructure(html: string): DocumentStructure {
    const headings: DocumentStructure['headings'] = [];
    const sections: DocumentStructure['sections'] = [];
    const metadata = {
      hasLists: /<[uo]l>/i.test(html),
      hasCode: /<code>|<pre>/i.test(html),
      hasTables: /<table>/i.test(html),
      hasImages: /<img/i.test(html)
    };

    // Extract headings with positions
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
    let match;
    while ((match = headingRegex.exec(html)) !== null) {
      const level = parseInt(match[1]);
      const rawText = match[2];
      const text = this.stripHtml(rawText);
      const anchor = this.generateAnchor(text);
      
      headings.push({
        level,
        text,
        anchor,
        startPos: match.index,
        endPos: match.index + match[0].length
      });
    }

    // Create sections based on headings
    if (headings.length === 0) {
      // No headings - treat entire document as one section
      sections.push({
        level: 1,
        content: html,
        startPos: 0,
        endPos: html.length
      });
    } else {
      // Create sections between headings
      for (let i = 0; i < headings.length; i++) {
        const heading = headings[i];
        const nextHeading = headings[i + 1];
        
        const startPos = heading.endPos;
        const endPos = nextHeading ? nextHeading.startPos : html.length;
        const content = html.slice(startPos, endPos);
        
        sections.push({
          heading: heading.text,
          level: heading.level,
          content,
          startPos,
          endPos,
          anchor: heading.anchor
        });
      }
    }

    return { headings, sections, metadata };
  }

  private async createSemanticChunks(page: ConfluencePage, structure: DocumentStructure): Promise<Chunk[]> {
    const chunks: Chunk[] = [];
    
    for (const section of structure.sections) {
      const sectionChunks = await this.chunkSection(page, section, structure.metadata);
      chunks.push(...sectionChunks);
    }
    
    return chunks;
  }

  private async chunkSection(
    page: ConfluencePage, 
    section: DocumentStructure['sections'][0],
    metadata: DocumentStructure['metadata']
  ): Promise<Chunk[]> {
    const plainText = this.stripHtml(section.content);
    const words = plainText.split(/\s+/).filter(Boolean);
    
    if (words.length <= this.config.minChunkWords) {
      // Section is small enough to be one chunk
      return [{
        id: randomUUID(),
        pageId: page.id,
        space: page.spaceKey,
        title: page.title,
        sectionAnchor: section.anchor,
        text: this.enhanceChunkText(plainText, section, metadata),
        version: page.version,
        updatedAt: page.updatedAt,
        labels: page.labels,
        url: page.url,
        metadata: {
          section: section.heading,
          level: section.level,
          hasCode: metadata.hasCode,
          hasTables: metadata.hasTables,
          hasLists: metadata.hasLists
        }
      }];
    }

    // Split large section into semantic chunks
    return this.createOverlappingChunks(page, section, plainText, words, metadata);
  }

  private createOverlappingChunks(
    page: ConfluencePage,
    section: DocumentStructure['sections'][0], 
    plainText: string,
    words: string[],
    metadata: DocumentStructure['metadata']
  ): Chunk[] {
    const chunks: Chunk[] = [];
    const targetWords = Math.min(this.config.maxChunkWords, this.config.targetChunkSize / 4);
    const overlapWords = Math.min(this.config.contextWindow, this.config.overlap / 4);
    
    // Create overlapping windows
    for (let i = 0; i < words.length; i += targetWords - overlapWords) {
      const chunkWords = words.slice(i, i + targetWords);
      if (chunkWords.length < this.config.minChunkWords) break;
      
      // Find semantic boundaries (sentence endings)
      const chunkText = this.findSemanticBoundary(chunkWords.join(' '));
      
      // Add context window
      const contextualText = this.addContextWindow(words, i, chunkWords.length, overlapWords);
      
      chunks.push({
        id: randomUUID(),
        pageId: page.id,
        space: page.spaceKey,
        title: page.title,
        sectionAnchor: section.anchor,
        text: this.enhanceChunkText(contextualText, section, metadata),
        version: page.version,
        updatedAt: page.updatedAt,
        labels: page.labels,
        url: page.url,
        metadata: {
          section: section.heading,
          level: section.level,
          hasCode: metadata.hasCode,
          hasTables: metadata.hasTables,
          hasLists: metadata.hasLists,
          chunkIndex: chunks.length,
          overlapStart: i > 0,
          overlapEnd: i + targetWords < words.length
        }
      });

      // Break if we've covered all words
      if (i + targetWords >= words.length) break;
    }
    
    return chunks;
  }

  private findSemanticBoundary(text: string): string {
    // Try to end on sentence boundaries
    const sentences = text.split(/[.!?]+/);
    if (sentences.length > 1) {
      // Remove last incomplete sentence if it's very short
      const lastSentence = sentences[sentences.length - 1].trim();
      if (lastSentence.length < 50 && sentences.length > 2) {
        return sentences.slice(0, -1).join('.') + '.';
      }
    }
    return text;
  }

  private addContextWindow(words: string[], startIdx: number, chunkLength: number, contextSize: number): string {
    // Add context before and after the main chunk
    const preContext = startIdx > 0 
      ? words.slice(Math.max(0, startIdx - contextSize), startIdx).join(' ') + ' '
      : '';
    
    const mainChunk = words.slice(startIdx, startIdx + chunkLength).join(' ');
    
    const postContext = startIdx + chunkLength < words.length
      ? ' ' + words.slice(startIdx + chunkLength, Math.min(words.length, startIdx + chunkLength + contextSize)).join(' ')
      : '';
    
    return preContext + mainChunk + postContext;
  }

  private enhanceChunkText(
    text: string, 
    section: DocumentStructure['sections'][0], 
    metadata: DocumentStructure['metadata']
  ): string {
    const enhancements: string[] = [];
    
    // Add section context
    if (section.heading) {
      enhancements.push(`Section: ${section.heading}`);
    }
    
    // Add document type hints
    if (metadata.hasCode) enhancements.push('Contains code examples');
    if (metadata.hasTables) enhancements.push('Contains tables');
    if (metadata.hasLists) enhancements.push('Contains lists');
    
    const contextPrefix = enhancements.length > 0 ? `[${enhancements.join(', ')}] ` : '';
    return contextPrefix + text;
  }

  private addHierarchicalRelationships(chunks: Chunk[], structure: DocumentStructure): Chunk[] {
    // Create parent-child relationships based on heading hierarchy
    const chunksWithHierarchy = chunks.map(chunk => ({
      ...chunk,
      relationships: {
        parentChunks: [] as string[],
        childChunks: [] as string[],
        siblingChunks: [] as string[]
      }
    }));
    
    // Build relationships based on section hierarchy
    for (let i = 0; i < chunksWithHierarchy.length; i++) {
      const chunk = chunksWithHierarchy[i];
      const chunkLevel = chunk.metadata?.level || 1;
      
      // Find parent chunks (higher level headings)
      for (let j = i - 1; j >= 0; j--) {
        const potentialParent = chunksWithHierarchy[j];
        const parentLevel = potentialParent.metadata?.level || 1;
        
        if (parentLevel < chunkLevel) {
          chunk.relationships.parentChunks.push(potentialParent.id);
          potentialParent.relationships.childChunks.push(chunk.id);
          break; // Only immediate parent
        }
      }
      
      // Find sibling chunks (same level)
      for (const otherChunk of chunksWithHierarchy) {
        if (otherChunk.id !== chunk.id && 
            otherChunk.metadata?.level === chunkLevel &&
            otherChunk.metadata?.section === chunk.metadata?.section) {
          chunk.relationships.siblingChunks.push(otherChunk.id);
        }
      }
    }
    
    return chunksWithHierarchy;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private generateAnchor(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }

  private estimateTokens(text: string): number {
    // More accurate token estimation
    return Math.ceil(text.length / 3.5); // Better average for technical content
  }
}