/**
 * Integration Guide for Optimized RAG Pipeline
 * 
 * This file provides examples and utilities for integrating the new optimized
 * RAG components with the existing system.
 */

import type { ConfluencePage } from '@app/shared';
import { OptimizedRAGPipeline } from './optimized-pipeline.js';
import { getPreset, createCustomPreset } from '../config/optimization-presets.js';

// Example: Basic integration with existing retrieval system
export class RAGSystemUpgrade {
  private pipeline: OptimizedRAGPipeline;
  
  constructor() {
    // Initialize with balanced preset for general use
    const config = getPreset('balanced');
    this.pipeline = new OptimizedRAGPipeline(config);
  }

  async initialize(): Promise<void> {
    await this.pipeline.initialize();
  }

  // Migration method: gradually replace existing chunking
  async migrateDocuments(
    documents: Array<{ page: ConfluencePage; content: string }>,
    batchSize: number = 10
  ): Promise<void> {
    console.log(`Starting migration of ${documents.length} documents...`);
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(({ page, content }) => 
          this.pipeline.processDocument(page, content)
        )
      );
      
      console.log(`Migrated ${Math.min(i + batchSize, documents.length)}/${documents.length} documents`);
    }
    
    console.log('✅ Migration completed');
  }

  // Enhanced query method that can fallback to old system
  async enhancedQuery(
    query: string,
    options?: {
      useOptimized?: boolean;
      fallbackToOld?: boolean;
      maxRetries?: number;
    }
  ) {
    const { useOptimized = true, fallbackToOld = true, maxRetries = 2 } = options || {};
    
    if (useOptimized) {
      try {
        const result = await this.pipeline.query(query, {
          enableExplainability: true
        });
        
        return {
          ...result,
          source: 'optimized'
        };
      } catch (error) {
        console.warn('Optimized query failed:', error);
        
        if (fallbackToOld) {
          console.log('Falling back to original system...');
          // Here you would call your existing query method
          // return await this.originalQuery(query);
          throw new Error('Fallback not implemented yet');
        } else {
          throw error;
        }
      }
    } else {
      // Use original system
      // return await this.originalQuery(query);
      throw new Error('Original query system not implemented in this example');
    }
  }
}

// Example: Custom configuration for specific use cases
export class CustomRAGConfigurations {
  
  // Configuration for code-heavy documentation
  static createCodeOptimizedConfig() {
    return createCustomPreset('quality', {
      chunking: {
        semanticThreshold: 0.9, // Higher threshold for code sections
        minChunkWords: 30, // Shorter chunks for code
        maxChunkWords: 100
      },
      embedding: {
        enableSparseEmbeddings: true,
        sparseWeight: 0.4, // Higher weight for keyword matching in code
        enableMetadataEmbedding: true
      },
      retrieval: {
        metadataBoosts: {
          hasCode: 0.5, // Strong boost for code content
          hasTables: 0.2
        },
        enableContextualCompression: false // Keep full context for code
      }
    });
  }

  // Configuration for FAQ/knowledge base
  static createFAQOptimizedConfig() {
    return createCustomPreset('balanced', {
      chunking: {
        semanticThreshold: 0.7,
        maxChunkWords: 250 // Longer chunks for comprehensive answers
      },
      retrieval: {
        enableHyDE: true, // Good for question-answer matching
        enableQueryExpansion: true,
        maxQueryVariants: 7,
        mmrLambda: 0.9 // Prefer relevance over diversity for FAQs
      }
    });
  }

  // Configuration for real-time applications
  static createRealtimeConfig() {
    return createCustomPreset('speed', {
      vectorStore: {
        enableCaching: true,
        cacheSize: 2000, // Larger cache for repeated queries
        enableBatching: false // Disable batching for lower latency
      },
      retrieval: {
        initialK: 8,
        finalK: 5, // Fewer results for speed
        enableTwoStageRetrieval: false
      },
      maxConcurrentEmbeddings: 8,
      processingTimeout: 10000 // 10 second timeout
    });
  }
}

// Example: A/B testing framework for optimization evaluation
export class OptimizationTester {
  private pipelineA: OptimizedRAGPipeline;
  private pipelineB: OptimizedRAGPipeline;
  private testResults: Array<{
    query: string;
    resultA: any;
    resultB: any;
    timestamp: number;
  }> = [];

  constructor(configA: any, configB: any) {
    this.pipelineA = new OptimizedRAGPipeline(configA);
    this.pipelineB = new OptimizedRAGPipeline(configB);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.pipelineA.initialize(),
      this.pipelineB.initialize()
    ]);
  }

  async compareQuery(query: string): Promise<{
    winner: 'A' | 'B' | 'tie';
    resultA: any;
    resultB: any;
    metrics: {
      speedDiff: number; // ms
      scoreDiff: number;
      resultCountDiff: number;
    };
  }> {
    const [resultA, resultB] = await Promise.all([
      this.pipelineA.query(query),
      this.pipelineB.query(query)
    ]);

    const metrics = {
      speedDiff: resultA.metrics.retrievalTime - resultB.metrics.retrievalTime,
      scoreDiff: resultA.metrics.averageScore - resultB.metrics.averageScore,
      resultCountDiff: resultA.chunks.length - resultB.chunks.length
    };

    // Simple winner determination (can be made more sophisticated)
    let winner: 'A' | 'B' | 'tie' = 'tie';
    if (metrics.scoreDiff > 0.1) {
      winner = 'A';
    } else if (metrics.scoreDiff < -0.1) {
      winner = 'B';
    } else if (Math.abs(metrics.speedDiff) > 100) {
      winner = metrics.speedDiff < 0 ? 'A' : 'B';
    }

    this.testResults.push({
      query,
      resultA,
      resultB,
      timestamp: Date.now()
    });

    return { winner, resultA, resultB, metrics };
  }

  getTestSummary() {
    const total = this.testResults.length;
    if (total === 0) return null;

    const wins = this.testResults.reduce((acc, result) => {
      // Recalculate winner for each result
      const scoreDiff = result.resultA.metrics.averageScore - result.resultB.metrics.averageScore;
      const speedDiff = result.resultA.metrics.retrievalTime - result.resultB.metrics.retrievalTime;
      
      if (scoreDiff > 0.1) {
        acc.A++;
      } else if (scoreDiff < -0.1) {
        acc.B++;
      } else if (Math.abs(speedDiff) > 100) {
        speedDiff < 0 ? acc.A++ : acc.B++;
      } else {
        acc.tie++;
      }
      
      return acc;
    }, { A: 0, B: 0, tie: 0 });

    return {
      totalTests: total,
      wins,
      winRates: {
        A: (wins.A / total * 100).toFixed(1) + '%',
        B: (wins.B / total * 100).toFixed(1) + '%',
        tie: (wins.tie / total * 100).toFixed(1) + '%'
      }
    };
  }
}

// Example: Monitoring and alerting for production use
export class RAGSystemMonitor {
  private pipeline: OptimizedRAGPipeline;
  private performanceHistory: Array<{
    timestamp: number;
    retrievalTime: number;
    averageScore: number;
    memoryUsage: number;
  }> = [];

  constructor(pipeline: OptimizedRAGPipeline) {
    this.pipeline = pipeline;
  }

  startMonitoring(intervalMs: number = 60000): void {
    setInterval(async () => {
      try {
        const stats = await this.pipeline.getSystemStats();
        
        this.performanceHistory.push({
          timestamp: Date.now(),
          retrievalTime: 0, // Would be populated from recent queries
          averageScore: 0, // Would be populated from recent queries
          memoryUsage: stats.cache.size
        });

        // Keep only last 100 entries
        if (this.performanceHistory.length > 100) {
          this.performanceHistory = this.performanceHistory.slice(-100);
        }

        this.checkAlerts();
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    }, intervalMs);
  }

  private checkAlerts(): void {
    if (this.performanceHistory.length < 5) return;

    const recent = this.performanceHistory.slice(-5);
    const avgRetrievalTime = recent.reduce((sum, entry) => sum + entry.retrievalTime, 0) / recent.length;
    const avgScore = recent.reduce((sum, entry) => sum + entry.averageScore, 0) / recent.length;

    // Alert conditions
    if (avgRetrievalTime > 2000) {
      console.warn('🚨 ALERT: High retrieval times detected');
    }

    if (avgScore < 0.5) {
      console.warn('🚨 ALERT: Low retrieval scores detected');
    }

    // Memory usage trend
    const memoryTrend = recent[recent.length - 1].memoryUsage - recent[0].memoryUsage;
    if (memoryTrend > 50) { // Growing cache by more than 50 entries
      console.warn('🚨 ALERT: Memory usage trending upward');
    }
  }

  getPerformanceReport(): any {
    if (this.performanceHistory.length === 0) {
      return { message: 'No performance data available' };
    }

    const data = this.performanceHistory;
    return {
      totalSamples: data.length,
      timeRange: {
        start: new Date(data[0].timestamp).toISOString(),
        end: new Date(data[data.length - 1].timestamp).toISOString()
      },
      averages: {
        retrievalTime: data.reduce((sum, entry) => sum + entry.retrievalTime, 0) / data.length,
        score: data.reduce((sum, entry) => sum + entry.averageScore, 0) / data.length,
        memoryUsage: data.reduce((sum, entry) => sum + entry.memoryUsage, 0) / data.length
      },
      trends: {
        // Simple trend calculation (positive = improving, negative = degrading)
        retrievalTime: this.calculateTrend(data.map(d => d.retrievalTime)),
        score: this.calculateTrend(data.map(d => d.averageScore)),
        memoryUsage: this.calculateTrend(data.map(d => d.memoryUsage))
      }
    };
  }

  private calculateTrend(values: number[]): string {
    if (values.length < 2) return 'insufficient_data';
    
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length;
    
    const change = ((secondAvg - firstAvg) / firstAvg * 100);
    
    if (Math.abs(change) < 5) return 'stable';
    return change > 0 ? 'increasing' : 'decreasing';
  }
}

// Export utilities for easy integration
export const IntegrationUtils = {
  RAGSystemUpgrade,
  CustomRAGConfigurations,
  OptimizationTester,
  RAGSystemMonitor
};