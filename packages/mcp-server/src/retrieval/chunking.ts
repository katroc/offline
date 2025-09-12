import { randomUUID } from 'crypto';
import type { Chunk, ConfluencePage } from '@app/shared';

// Base configuration for chunking
export interface ChunkingConfig {
  targetChunkSize: number; // tokens
  overlap: number; // tokens
  maxChunkSize: number; // tokens
}

// Extended configuration for semantic chunking
export interface SemanticChunkingConfig extends ChunkingConfig {
  semanticThreshold: number; // 0.0-1.0, similarity threshold for semantic boundaries
  preserveStructure: boolean; // Keep HTML structure info
  minChunkWords: number; // Minimum words per chunk
  maxChunkWords: number; // Maximum words per chunk
  contextWindow: number; // Words of context to include around chunk
  enableHierarchical: boolean; // Create parent-child relationships
}

// Document structure analysis
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
    hasCode: boolean;
    hasTables: boolean;
    hasLists: boolean;
    hasImages: boolean;
    totalWords: number;
    avgWordsPerSection: number;
  };
}

// Unified chunker interface
export interface Chunker {
  chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]>;
}

/**
 * Simple token-based chunker with section awareness.
 * Fast, reliable, and works well for most use cases.
 */
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
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractSections(text: string): Array<{ heading?: string; content: string; anchor?: string }> {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const sections: Array<{ heading?: string; content: string; anchor?: string }> = [];
    
    let currentSection: { heading?: string; content: string; anchor?: string } = { content: '' };
    
    for (const line of lines) {
      // Simple heading detection (lines that are short and end without punctuation)
      if (line.length < 100 && !line.match(/[.!?:]$/)) {
        if (currentSection.content.trim()) {
          sections.push(currentSection);
        }
        currentSection = {
          heading: line,
          content: '',
          anchor: this.generateAnchor(line)
        };
      } else {
        currentSection.content += (currentSection.content ? ' ' : '') + line;
      }
    }
    
    if (currentSection.content.trim()) {
      sections.push(currentSection);
    }
    
    return sections;
  }

  private async chunkSection(
    page: ConfluencePage, 
    section: { heading?: string; content: string; anchor?: string }
  ): Promise<Chunk[]> {
    const words = section.content.split(/\s+/);
    const chunks: Chunk[] = [];
    
    // Rough tokens = words * 1.3
    const wordsPerChunk = Math.floor(this.config.targetChunkSize / 1.3);
    const overlapWords = Math.floor(this.config.overlap / 1.3);

    for (let i = 0; i < words.length; i += wordsPerChunk - overlapWords) {
      const chunkWords = words.slice(i, i + wordsPerChunk);
      if (chunkWords.length === 0) {break;}

      const chunkText = chunkWords.join(' ');
      chunks.push({
        id: randomUUID(),
        pageId: page.id,
        text: chunkText,
        vector: [], // Will be populated by embedder
        url: page.url,
        title: page.title,
        space: page.spaceKey,
        labels: page.labels,
        version: page.version,
        updatedAt: page.updatedAt,
        sectionAnchor: section.anchor,
        indexedAt: new Date().toISOString(),
        metadata: { sectionHeading: section.heading }
      });

      // Prevent infinite loop
      if (i + wordsPerChunk >= words.length) {break;}
    }

    return chunks;
  }

  private generateAnchor(text: string): string {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
  }
}

/**
 * Advanced semantic chunker with structure awareness and hierarchical chunking.
 * Provides better context preservation but requires more processing.
 */
export class SemanticChunker implements Chunker {
  constructor(private config: SemanticChunkingConfig) {}

  async chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]> {
    // Analyze document structure
    const structure = this.analyzeDocumentStructure(content);
    
    // Create base chunks from structure
    const baseChunks = this.createStructuralChunks(page, structure, content);
    
    // Apply semantic boundaries if needed
    const semanticChunks = await this.refineWithSemanticBoundaries(baseChunks);
    
    // Add hierarchical relationships if enabled
    if (this.config.enableHierarchical) {
      return this.addHierarchicalRelationships(semanticChunks, structure);
    }
    
    return semanticChunks;
  }

  private analyzeDocumentStructure(content: string): DocumentStructure {
    const headings: DocumentStructure['headings'] = [];
    const sections: DocumentStructure['sections'] = [];
    
    // Extract headings with regex
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
    let match;
    
    while ((match = headingRegex.exec(content)) !== null) {
      const level = parseInt(match[1]);
      const text = match[2].replace(/<[^>]+>/g, '').trim();
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
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      const nextHeading = headings[i + 1];
      const endPos = nextHeading ? nextHeading.startPos : content.length;
      
      const sectionContent = content.slice(heading.endPos, endPos);
      const plainContent = this.htmlToText(sectionContent);
      
      sections.push({
        heading: heading.text,
        level: heading.level,
        content: plainContent,
        startPos: heading.startPos,
        endPos,
        anchor: heading.anchor
      });
    }
    
    // If no headings, create one big section
    if (sections.length === 0) {
      sections.push({
        level: 1,
        content: this.htmlToText(content),
        startPos: 0,
        endPos: content.length
      });
    }
    
    // Calculate metadata
    const totalWords = sections.reduce((sum, s) => sum + s.content.split(/\s+/).length, 0);
    const metadata = {
      hasCode: /<code|<pre/.test(content),
      hasTables: /<table|<td|<th/.test(content),
      hasLists: /<ul|<ol|<li/.test(content),
      hasImages: /<img/.test(content),
      totalWords,
      avgWordsPerSection: sections.length > 0 ? Math.round(totalWords / sections.length) : 0
    };
    
    return { headings, sections, metadata };
  }

  private createStructuralChunks(
    page: ConfluencePage, 
    structure: DocumentStructure, 
    originalContent: string
  ): Chunk[] {
    const chunks: Chunk[] = [];
    
    for (const section of structure.sections) {
      const words = section.content.split(/\s+/).filter(Boolean);
      const wordsPerChunk = Math.min(this.config.maxChunkWords, 
        Math.max(this.config.minChunkWords, this.config.targetChunkSize / 1.3));
      
      // Split large sections into smaller chunks
      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunkWords = words.slice(i, Math.min(i + wordsPerChunk, words.length));
        if (chunkWords.length < this.config.minChunkWords && i > 0) {
          // Merge small trailing chunk with previous chunk
          const lastChunk = chunks[chunks.length - 1];
          if (lastChunk && lastChunk.metadata?.sectionHeading === section.heading) {
            lastChunk.text += ' ' + chunkWords.join(' ');
            continue;
          }
        }
        
        const chunkText = chunkWords.join(' ');
        if (chunkText.trim()) {
          chunks.push({
            id: randomUUID(),
            pageId: page.id,
            text: chunkText,
            vector: [], // Will be populated by embedder
            url: page.url,
            title: page.title,
            space: page.spaceKey,
            labels: page.labels,
            version: page.version,
            updatedAt: page.updatedAt,
            sectionAnchor: section.anchor,
            indexedAt: new Date().toISOString(),
            metadata: { sectionHeading: section.heading }
          });
        }
      }
    }
    
    return chunks;
  }

  private async refineWithSemanticBoundaries(chunks: Chunk[]): Promise<Chunk[]> {
    // For now, return chunks as-is
    // In a full implementation, this would use embeddings to detect semantic boundaries
    // and potentially merge or split chunks based on semantic similarity
    return chunks;
  }

  private addHierarchicalRelationships(
    chunks: Chunk[], 
    structure: DocumentStructure
  ): Chunk[] {
    // Add parent-child relationships based on heading hierarchy
    // This could be implemented to create chunk relationships based on document structure
    return chunks;
  }

  private htmlToText(html: string): string {
    return html
      .replace(/<script[^>]*>.*?<\/script>/gis, '')
      .replace(/<style[^>]*>.*?<\/style>/gis, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private generateAnchor(text: string): string {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
  }
}

/**
 * Universal chunker that can switch between different chunking strategies
 */
export class UniversalChunker implements Chunker {
  private simpleChunker: SimpleChunker;
  private semanticChunker?: SemanticChunker;
  
  constructor(
    private strategy: 'simple' | 'semantic' = 'simple',
    private config: ChunkingConfig | SemanticChunkingConfig
  ) {
    this.simpleChunker = new SimpleChunker(config);
    
    if (strategy === 'semantic' && this.isSemanticConfig(config)) {
      this.semanticChunker = new SemanticChunker(config);
    }
  }

  async chunkDocument(page: ConfluencePage, content: string): Promise<Chunk[]> {
    if (this.strategy === 'semantic' && this.semanticChunker) {
      return this.semanticChunker.chunkDocument(page, content);
    }
    
    return this.simpleChunker.chunkDocument(page, content);
  }

  private isSemanticConfig(config: ChunkingConfig): config is SemanticChunkingConfig {
    return 'semanticThreshold' in config;
  }
}

// Legacy interface name for backward compatibility  
export { SimpleChunker as LegacyChunker };