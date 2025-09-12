import type { Chunk, Filters, Citation, ConfluencePage } from '@app/shared';
import type { DocumentSourceClient, DocumentSource } from '../sources/interfaces.js';
import { LocalDocStore } from '../store/local-doc-store.js';
import { getPreset } from '../config/optimization-presets.js';
import { embed as baseEmbed } from '../llm/embeddings.js';
import type { VectorStore } from './vector-store.js';
import type { RAGPipeline, RetrievalResult } from './pipeline.js';
import { OptimizedRAGPipeline } from './optimized-pipeline.js';

/**
 * Integration layer that adds optimized RAG capabilities to the existing system
 * while maintaining backward compatibility with the current pipeline.
 */
export class OptimizedRAGIntegration implements RAGPipeline {
  private optimizedPipeline: OptimizedRAGPipeline;
  private fallbackPipeline: RAGPipeline;
  private isOptimizedEnabled: boolean;

  constructor(
    private documentClient: DocumentSourceClient,
    private vectorStore: VectorStore,
    private chunker: any,
    private localDocStore?: LocalDocStore,
    fallbackPipeline?: RAGPipeline
  ) {
    // Allow preset override via env; default to balanced
    const presetName = (process.env.OPTIMIZED_PRESET as any) || 'balanced';
    const config = getPreset(presetName);
    this.optimizedPipeline = new OptimizedRAGPipeline(config);
    
    this.fallbackPipeline = fallbackPipeline!;
    
    // Enable optimized pipeline via env var USE_OPTIMIZED_PIPELINE
    // Aligns with orchestrator selection
    this.isOptimizedEnabled = process.env.USE_OPTIMIZED_PIPELINE === 'true';
    
    console.log(`🚀 OptimizedRAG Integration initialized (enabled: ${this.isOptimizedEnabled}, preset: ${presetName})`);
  }

  async initialize(): Promise<void> {
    await this.optimizedPipeline.initialize();
    console.log('✅ OptimizedRAG Integration ready');
  }

  async retrieveForQuery(
    queries: string | string[],
    filters: Filters,
    topK: number,
    model?: string,
    conversationId?: string,
    intent?: { intent: string; confidence: number; normalizedQuery?: string }
  ): Promise<RetrievalResult> {
    
    if (!this.isOptimizedEnabled) {
      console.log('📊 Using fallback pipeline (optimized disabled)');
      return this.fallbackPipeline.retrieveForQuery(queries, filters, topK, model, conversationId, intent);
    }

    try {
      const startTime = Date.now();
      
      // Use the primary query from the variants
      const primaryQuery = Array.isArray(queries) ? queries[0] : queries;
      console.log(`🔍 OptimizedRAG retrieving for: "${primaryQuery}"`);

      // Convert filters to optimized format
      const optimizedOptions = {
        spaceId: filters.space || 'default',
        filters: {
          space: filters.space,
          labels: filters.labels,
          updatedAfter: filters.updatedAfter
        },
        contextLength: topK,
        enableExplainability: true
      };

      // Query using optimized pipeline
      const result = await this.optimizedPipeline.query(primaryQuery, optimizedOptions);
      
      // Convert back to legacy format
      const citations = this.chunksToCitations(result.chunks);
      
      const retrievalTime = Date.now() - startTime;
      console.log(`✅ OptimizedRAG completed in ${retrievalTime}ms (${result.chunks.length} chunks, avg score: ${result.metrics.averageScore.toFixed(3)})`);
      
      // Log optimization details if available
      if (result.explanation) {
        const details = [];
        if (result.explanation.expandedQueries) {
          details.push(`expanded ${result.explanation.expandedQueries.length} queries`);
        }
        if (result.explanation.hydeDocument) {
          details.push('used HyDE');
        }
        if (result.explanation.rerankingApplied) {
          details.push('reranked');
        }
        if (details.length > 0) {
          console.log(`🔧 Optimizations applied: ${details.join(', ')}`);
        }
      }

      return {
        chunks: result.chunks.slice(0, topK), // Ensure we don't exceed requested count
        citations
      };

    } catch (error) {
      console.warn('⚠️ OptimizedRAG failed, falling back to original pipeline:', error);
      
      // Fallback to original pipeline
      return this.fallbackPipeline.retrieveForQuery(queries, filters, topK, model, conversationId, intent);
    }
  }

  async indexDocument(document: DocumentSource): Promise<void> {
    try {
      console.log(`📥 OptimizedRAG indexing document: ${document.title} (${document.id})`);
      
      // Convert DocumentSource to ConfluencePage format for optimized pipeline
      const page: ConfluencePage = {
        id: document.id,
        title: document.title,
        spaceKey: document.space || document.spaceKey || 'default',
        version: document.version || 1,
        updatedAt: document.updatedAt || new Date().toISOString(),
        url: document.url || `doc://${document.id}`,
        labels: document.labels || []
      };

      // Process with optimized pipeline
      const startTime = Date.now();
      const result = await this.optimizedPipeline.processDocument(page, document.content, document.space || 'default');
      const processingTime = Date.now() - startTime;
      
      console.log(`✅ OptimizedRAG indexed in ${processingTime}ms (${result.chunks.length} chunks, quality: ${(result.metrics.averageChunkQuality * 100).toFixed(1)}%)`);
      
      // Also index with fallback pipeline for compatibility
      if (this.fallbackPipeline) {
        await this.fallbackPipeline.indexDocument(document);
      }

    } catch (error) {
      console.error('❌ OptimizedRAG indexing failed:', error);
      
      // Fallback to original indexing
      if (this.fallbackPipeline) {
        await this.fallbackPipeline.indexDocument(document);
      } else {
        throw error;
      }
    }
  }

  async deleteDocument(pageId: string): Promise<void> {
    // For now, delegate to fallback pipeline
    // In future, we could add deletion support to optimized vector store
    console.log(`🗑️ Deleting document: ${pageId}`);
    
    if (this.fallbackPipeline) {
      await this.fallbackPipeline.deleteDocument(pageId);
    }
  }

  // Utility methods
  private chunksToCitations(chunks: Chunk[]): Citation[] {
    return chunks.map(chunk => ({
      pageId: chunk.pageId,
      title: chunk.title,
      url: chunk.url || `doc://${chunk.pageId}`,
      space: chunk.space,
      labels: chunk.labels || [],
      snippet: chunk.text.substring(0, 200) + (chunk.text.length > 200 ? '...' : ''),
      anchor: chunk.sectionAnchor
    }));
  }

  // Performance monitoring
  async getOptimizationStats(): Promise<{
    enabled: boolean;
    systemStats?: any;
    recommendations: string[];
  }> {
    if (!this.isOptimizedEnabled) {
      return {
        enabled: false,
        recommendations: ['Enable optimized RAG with ENABLE_OPTIMIZED_RAG=true']
      };
    }

    const systemStats = await this.optimizedPipeline.getSystemStats();
    
    const recommendations: string[] = [];
    
    // Performance recommendations based on stats
    if (systemStats.averageProcessingTime > 2000) {
      recommendations.push('Consider switching to "speed" preset for better performance');
    }
    
    if (systemStats.vectorStore.documentCount < 100) {
      recommendations.push('More documents needed for optimal vector search performance');
    }
    
    if (systemStats.cache.size / systemStats.cache.maxSize > 0.8) {
      recommendations.push('Consider increasing cache size for better performance');
    }

    return {
      enabled: true,
      systemStats,
      recommendations
    };
  }

  // Configuration management
  switchPreset(presetName: 'performance' | 'quality' | 'speed' | 'balanced'): void {
    console.log(`🔄 Switching to ${presetName} preset`);
    const newConfig = getPreset(presetName);
    this.optimizedPipeline.updateConfig(newConfig);
  }

  toggleOptimization(enabled: boolean): void {
    this.isOptimizedEnabled = enabled;
    console.log(`🔄 OptimizedRAG ${enabled ? 'enabled' : 'disabled'}`);
  }

  // Benchmarking helper
  async runQuickBenchmark(testQuery: string = 'How to use Docker containers'): Promise<{
    optimizedTime: number;
    fallbackTime: number;
    optimizedResults: number;
    fallbackResults: number;
    speedImprovement: string;
  }> {
    console.log('🏃 Running quick benchmark...');
    
    const filters: Filters = { space: undefined, labels: undefined, updatedAfter: undefined };
    const topK = 5;

    // Test optimized pipeline
    const optStart = Date.now();
    this.isOptimizedEnabled = true;
    const optResult = await this.retrieveForQuery(testQuery, filters, topK);
    const optimizedTime = Date.now() - optStart;

    // Test fallback pipeline
    const fallStart = Date.now();
    this.isOptimizedEnabled = false;
    const fallResult = await this.retrieveForQuery(testQuery, filters, topK);
    const fallbackTime = Date.now() - fallStart;

    // Re-enable optimized
    this.isOptimizedEnabled = true;

    const speedImprovement = fallbackTime > optimizedTime 
      ? `${((fallbackTime - optimizedTime) / fallbackTime * 100).toFixed(1)}% faster`
      : `${((optimizedTime - fallbackTime) / optimizedTime * 100).toFixed(1)}% slower`;

    const result = {
      optimizedTime,
      fallbackTime,
      optimizedResults: optResult.chunks.length,
      fallbackResults: fallResult.chunks.length,
      speedImprovement
    };

    console.log('📊 Benchmark Results:');
    console.log(`   Optimized: ${optimizedTime}ms (${result.optimizedResults} results)`);
    console.log(`   Fallback:  ${fallbackTime}ms (${result.fallbackResults} results)`);
    console.log(`   Speed:     ${speedImprovement}`);

    return result;
  }
}
