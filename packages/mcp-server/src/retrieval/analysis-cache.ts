import type { AnalysisResult } from './llm-analysis.js';

export interface CacheKey {
  documentId: string;
  documentVersion: number;
  query: string;
  contextHash: string; // Hash of conversation context
}

export interface CacheEntry {
  key: CacheKey;
  result: AnalysisResult;
  timestamp: number;
  accessCount: number;
}

/**
 * Smart caching system for document analysis results
 * Avoids expensive re-analysis of the same documents
 */
export class AnalysisCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize = 1000; // Maximum cache entries
  private ttlMs = 24 * 60 * 60 * 1000; // 24 hours TTL

  /**
   * Get cached analysis result if available and valid
   */
  get(key: CacheKey): AnalysisResult | null {
    const cacheId = this.buildCacheId(key);
    const entry = this.cache.get(cacheId);
    
    if (!entry) {return null;}
    
    // Check if entry is expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(cacheId);
      return null;
    }
    
    // Update access count and timestamp for LRU
    entry.accessCount++;
    entry.timestamp = Date.now();
    
    return entry.result;
  }

  /**
   * Store analysis result in cache
   */
  set(key: CacheKey, result: AnalysisResult): void {
    // Evict old entries if cache is full
    if (this.cache.size >= this.maxSize) {
      this.evictLeastUsed();
    }
    
    const cacheId = this.buildCacheId(key);
    const entry: CacheEntry = {
      key,
      result,
      timestamp: Date.now(),
      accessCount: 1
    };
    
    this.cache.set(cacheId, entry);
  }

  /**
   * Check if we have a cached result for this combination
   */
  has(key: CacheKey): boolean {
    const cacheId = this.buildCacheId(key);
    const entry = this.cache.get(cacheId);
    
    if (!entry) {return false;}
    
    // Check expiration
    return Date.now() - entry.timestamp <= this.ttlMs;
  }

  /**
   * Build unique cache ID from key components
   */
  private buildCacheId(key: CacheKey): string {
    return `${key.documentId}:${key.documentVersion}:${this.hashString(key.query)}:${key.contextHash}`;
  }

  /**
   * Simple string hash for query deduplication
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Hash conversation context for cache key
   */
  hashContext(topicContext: string[], entities: string[], previousQueries: string[]): string {
    const contextString = [
      ...topicContext.sort(),
      ...entities.sort(), 
      ...previousQueries.slice(-2) // Only last 2 queries affect context
    ].join('|');
    
    return this.hashString(contextString);
  }

  /**
   * Evict least recently used entries
   */
  private evictLeastUsed(): void {
    const entries = Array.from(this.cache.entries());
    
    // Sort by access count (ascending) and timestamp (ascending)
    entries.sort(([, a], [, b]) => {
      if (a.accessCount !== b.accessCount) {
        return a.accessCount - b.accessCount;
      }
      return a.timestamp - b.timestamp;
    });
    
    // Remove bottom 20% of entries
    const toRemove = Math.floor(entries.length * 0.2) || 1;
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const expired: string[] = [];
    
    for (const [cacheId, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        expired.push(cacheId);
      }
    }
    
    expired.forEach(id => this.cache.delete(id));
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.calculateHitRate(),
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  private calculateHitRate(): number {
    let totalAccess = 0;
    let totalHits = 0;
    
    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
      totalHits += entry.accessCount - 1; // First access is not a hit
    }
    
    return totalAccess > 0 ? totalHits / totalAccess : 0;
  }

  private estimateMemoryUsage(): number {
    // Rough estimate in bytes
    let size = 0;
    for (const entry of this.cache.values()) {
      size += JSON.stringify(entry).length * 2; // UTF-16 characters
    }
    return size;
  }

  /**
   * Invalidate cache entries for a specific document (when document changes)
   */
  invalidateDocument(documentId: string): void {
    const toDelete: string[] = [];
    
    for (const [cacheId, entry] of this.cache.entries()) {
      if (entry.key.documentId === documentId) {
        toDelete.push(cacheId);
      }
    }
    
    toDelete.forEach(id => this.cache.delete(id));
  }
}

// Global cache instance
export const analysisCache = new AnalysisCache();

// Cleanup expired entries every hour
setInterval(() => {
  analysisCache.cleanup();
}, 60 * 60 * 1000);