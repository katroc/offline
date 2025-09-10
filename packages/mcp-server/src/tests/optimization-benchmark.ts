import type { ConfluencePage } from '@app/shared';
import { OptimizedRAGPipeline, type ProcessingMetrics } from '../retrieval/optimized-pipeline.js';
import { OPTIMIZATION_PRESETS, type PresetName } from '../config/optimization-presets.js';

interface BenchmarkResult {
  preset: PresetName;
  processingMetrics: ProcessingMetrics;
  queryMetrics: {
    averageRetrievalTime: number;
    averageScore: number;
    totalQueries: number;
  };
  qualityMetrics: {
    chunkQuality: number;
    retrievalAccuracy: number;
    diversityScore: number;
  };
  memoryUsage: number;
}

export class OptimizationBenchmark {
  private testDocuments: Array<{ page: ConfluencePage; content: string }> = [];
  private testQueries: string[] = [];

  constructor() {
    this.setupTestData();
  }

  private setupTestData(): void {
    // Sample test documents
    this.testDocuments = [
      {
        page: {
          id: 'test-1',
          title: 'Getting Started with Docker',
          spaceKey: 'DEV',
          version: 1,
          updatedAt: '2024-01-01T00:00:00Z',
          url: 'https://example.com/docker',
          labels: ['docker', 'containerization', 'devops']
        },
        content: `
          <h1>Getting Started with Docker</h1>
          <p>Docker is a platform for developing, shipping, and running applications in containers.</p>
          
          <h2>Installation</h2>
          <p>To install Docker on your system, follow these steps:</p>
          <ol>
            <li>Download Docker Desktop from the official website</li>
            <li>Run the installer and follow the setup wizard</li>
            <li>Restart your computer if prompted</li>
          </ol>
          
          <h2>Basic Commands</h2>
          <p>Here are some essential Docker commands:</p>
          <code>
            docker run hello-world
            docker ps
            docker images
            docker build -t myapp .
          </code>
          
          <h2>Creating a Dockerfile</h2>
          <p>A Dockerfile contains instructions for building a Docker image:</p>
          <pre>
            FROM node:18
            WORKDIR /app
            COPY package*.json ./
            RUN npm install
            COPY . .
            EXPOSE 3000
            CMD ["npm", "start"]
          </pre>
        `
      },
      {
        page: {
          id: 'test-2',
          title: 'JavaScript Best Practices',
          spaceKey: 'DEV',
          version: 1,
          updatedAt: '2024-01-02T00:00:00Z',
          url: 'https://example.com/js-best-practices',
          labels: ['javascript', 'best-practices', 'coding-standards']
        },
        content: `
          <h1>JavaScript Best Practices</h1>
          <p>Following best practices ensures your JavaScript code is maintainable and performant.</p>
          
          <h2>Variable Declarations</h2>
          <p>Always use const for variables that don't change, and let for variables that do:</p>
          <code>
            const API_URL = 'https://api.example.com';
            let userCount = 0;
          </code>
          
          <h2>Function Definitions</h2>
          <p>Prefer arrow functions for short, simple functions:</p>
          <code>
            const multiply = (a, b) => a * b;
            const users = data.map(user => user.name);
          </code>
          
          <h2>Error Handling</h2>
          <p>Always handle errors gracefully:</p>
          <code>
            try {
              const data = await fetchUserData();
              return data;
            } catch (error) {
              console.error('Failed to fetch user data:', error);
              throw error;
            }
          </code>
          
          <h2>Performance Tips</h2>
          <ul>
            <li>Avoid memory leaks by cleaning up event listeners</li>
            <li>Use debouncing for expensive operations</li>
            <li>Minimize DOM manipulations</li>
            <li>Use requestAnimationFrame for animations</li>
          </ul>
        `
      },
      {
        page: {
          id: 'test-3',
          title: 'Database Design Principles',
          spaceKey: 'ARCH',
          version: 1,
          updatedAt: '2024-01-03T00:00:00Z',
          url: 'https://example.com/database-design',
          labels: ['database', 'design', 'architecture']
        },
        content: `
          <h1>Database Design Principles</h1>
          <p>Good database design is crucial for application performance and maintainability.</p>
          
          <h2>Normalization</h2>
          <p>Database normalization eliminates redundancy and improves data integrity.</p>
          
          <h3>First Normal Form (1NF)</h3>
          <p>Each table cell contains only atomic values, and each column contains values of a single type.</p>
          
          <h3>Second Normal Form (2NF)</h3>
          <p>Must be in 1NF and all non-key attributes must depend on the entire primary key.</p>
          
          <h3>Third Normal Form (3NF)</h3>
          <p>Must be in 2NF and all attributes must depend only on the primary key.</p>
          
          <h2>Indexing Strategy</h2>
          <table>
            <tr><th>Index Type</th><th>Use Case</th><th>Performance</th></tr>
            <tr><td>B-tree</td><td>General purpose</td><td>Good</td></tr>
            <tr><td>Hash</td><td>Equality searches</td><td>Excellent</td></tr>
            <tr><td>Bitmap</td><td>Low cardinality</td><td>Good</td></tr>
          </table>
          
          <h2>Query Optimization</h2>
          <p>Optimize your queries by:</p>
          <ul>
            <li>Using appropriate indexes</li>
            <li>Avoiding SELECT *</li>
            <li>Using LIMIT when appropriate</li>
            <li>Analyzing query execution plans</li>
          </ul>
        `
      }
    ];

    // Sample test queries
    this.testQueries = [
      'How do I install Docker?',
      'What are Docker basic commands?',
      'How to create a Dockerfile?',
      'JavaScript variable declarations',
      'Arrow functions in JavaScript',
      'Error handling best practices',
      'What is database normalization?',
      'First normal form explained',
      'Database indexing strategy',
      'Query optimization techniques',
      'Performance tips for JavaScript',
      'Docker containerization guide',
      'Database design principles',
      'JavaScript coding standards'
    ];
  }

  async runComprehensiveBenchmark(): Promise<{
    results: BenchmarkResult[];
    comparison: {
      fastest: PresetName;
      mostAccurate: PresetName;
      bestBalanced: PresetName;
      recommendations: string[];
    };
  }> {
    console.log('Starting comprehensive optimization benchmark...');
    
    const results: BenchmarkResult[] = [];
    
    // Test each preset
    for (const presetName of Object.keys(OPTIMIZATION_PRESETS) as PresetName[]) {
      console.log(`\nTesting preset: ${presetName}`);
      
      const result = await this.benchmarkPreset(presetName);
      results.push(result);
      
      console.log(`✓ Completed ${presetName} preset benchmark`);
    }
    
    // Analyze results and provide recommendations
    const comparison = this.analyzeResults(results);
    
    console.log('\n📊 Benchmark completed!');
    this.printSummary(results, comparison);
    
    return { results, comparison };
  }

  private async benchmarkPreset(presetName: PresetName): Promise<BenchmarkResult> {
    const config = OPTIMIZATION_PRESETS[presetName];
    const pipeline = new OptimizedRAGPipeline(config);
    
    await pipeline.initialize();
    
    // Process documents and measure performance
    let totalProcessingMetrics: ProcessingMetrics = {
      chunkingTime: 0,
      embeddingTime: 0,
      indexingTime: 0,
      retrievalTime: 0,
      totalProcessingTime: 0,
      chunksProcessed: 0,
      chunksFiltered: 0,
      averageChunkQuality: 0,
      memoryUsage: 0
    };
    
    for (const doc of this.testDocuments) {
      const { metrics } = await pipeline.processDocument(doc.page, doc.content);
      
      // Aggregate metrics
      totalProcessingMetrics.chunkingTime += metrics.chunkingTime;
      totalProcessingMetrics.embeddingTime += metrics.embeddingTime;
      totalProcessingMetrics.indexingTime += metrics.indexingTime;
      totalProcessingMetrics.totalProcessingTime += metrics.totalProcessingTime;
      totalProcessingMetrics.chunksProcessed += metrics.chunksProcessed;
      totalProcessingMetrics.chunksFiltered += metrics.chunksFiltered;
      totalProcessingMetrics.averageChunkQuality += metrics.averageChunkQuality;
      totalProcessingMetrics.memoryUsage = Math.max(totalProcessingMetrics.memoryUsage, metrics.memoryUsage);
    }
    
    // Average the quality metrics
    totalProcessingMetrics.averageChunkQuality /= this.testDocuments.length;
    
    // Test queries and measure retrieval performance
    let totalRetrievalTime = 0;
    let totalScores = 0;
    let totalResults = 0;
    let relevantResults = 0;
    
    for (const query of this.testQueries) {
      const queryResult = await pipeline.query(query, { enableExplainability: true });
      
      totalRetrievalTime += queryResult.metrics.retrievalTime;
      totalScores += queryResult.metrics.averageScore;
      totalResults += queryResult.chunks.length;
      
      // Simple relevance check (results with score > 0.7 considered relevant)
      relevantResults += queryResult.scores.filter(score => score > 0.7).length;
    }
    
    const queryMetrics = {
      averageRetrievalTime: totalRetrievalTime / this.testQueries.length,
      averageScore: totalScores / this.testQueries.length,
      totalQueries: this.testQueries.length
    };
    
    const qualityMetrics = {
      chunkQuality: totalProcessingMetrics.averageChunkQuality,
      retrievalAccuracy: relevantResults / totalResults,
      diversityScore: this.calculateDiversityScore(config)
    };
    
    return {
      preset: presetName,
      processingMetrics: totalProcessingMetrics,
      queryMetrics,
      qualityMetrics,
      memoryUsage: totalProcessingMetrics.memoryUsage
    };
  }

  private calculateDiversityScore(config: any): number {
    // Simple diversity score based on MMR settings and other diversity features
    let score = 0;
    
    if (config.retrieval.enableMMR) {
      score += (1 - config.retrieval.mmrLambda) * 0.5; // Higher diversity weight = higher score
    }
    
    if (config.retrieval.enableQueryExpansion) {
      score += 0.2;
    }
    
    if (config.embedding.enableSparseEmbeddings) {
      score += 0.1;
    }
    
    if (config.retrieval.enableContextualCompression) {
      score += 0.2;
    }
    
    return Math.min(1, score);
  }

  private analyzeResults(results: BenchmarkResult[]): {
    fastest: PresetName;
    mostAccurate: PresetName;
    bestBalanced: PresetName;
    recommendations: string[];
  } {
    // Find fastest (lowest average retrieval time)
    const fastest = results.reduce((prev, current) => 
      current.queryMetrics.averageRetrievalTime < prev.queryMetrics.averageRetrievalTime ? current : prev
    ).preset;
    
    // Find most accurate (highest retrieval accuracy)
    const mostAccurate = results.reduce((prev, current) => 
      current.qualityMetrics.retrievalAccuracy > prev.qualityMetrics.retrievalAccuracy ? current : prev
    ).preset;
    
    // Find best balanced (composite score)
    const bestBalanced = results.reduce((prev, current) => {
      const prevScore = this.calculateBalanceScore(prev);
      const currentScore = this.calculateBalanceScore(current);
      return currentScore > prevScore ? current : prev;
    }).preset;
    
    const recommendations = this.generateRecommendations(results);
    
    return { fastest, mostAccurate, bestBalanced, recommendations };
  }

  private calculateBalanceScore(result: BenchmarkResult): number {
    // Weighted composite score balancing speed, accuracy, and quality
    const speedScore = 1 / Math.max(result.queryMetrics.averageRetrievalTime, 1); // Inverse of time
    const accuracyScore = result.qualityMetrics.retrievalAccuracy;
    const qualityScore = result.qualityMetrics.chunkQuality;
    const diversityScore = result.qualityMetrics.diversityScore;
    
    // Normalize speed score to 0-1 range (assuming 1000ms is baseline)
    const normalizedSpeedScore = Math.min(1, speedScore / 1000);
    
    return (
      normalizedSpeedScore * 0.3 +
      accuracyScore * 0.4 +
      qualityScore * 0.2 +
      diversityScore * 0.1
    );
  }

  private generateRecommendations(results: BenchmarkResult[]): string[] {
    const recommendations: string[] = [];
    
    // Performance recommendations
    const avgRetrievalTime = results.reduce((sum, r) => sum + r.queryMetrics.averageRetrievalTime, 0) / results.length;
    if (avgRetrievalTime > 500) {
      recommendations.push('Consider using the "speed" preset for better performance in latency-sensitive applications');
    }
    
    // Quality recommendations
    const avgAccuracy = results.reduce((sum, r) => sum + r.qualityMetrics.retrievalAccuracy, 0) / results.length;
    if (avgAccuracy < 0.7) {
      recommendations.push('Consider using the "quality" preset for applications requiring higher accuracy');
    }
    
    // Memory usage recommendations
    const maxMemoryUsage = Math.max(...results.map(r => r.memoryUsage));
    if (maxMemoryUsage > 500 * 1024 * 1024) { // 500MB
      recommendations.push('Consider reducing batch sizes or disabling document-level embeddings to reduce memory usage');
    }
    
    // Feature-specific recommendations
    const qualityPreset = results.find(r => r.preset === 'quality');
    const speedPreset = results.find(r => r.preset === 'speed');
    
    if (qualityPreset && speedPreset) {
      const qualityGain = qualityPreset.qualityMetrics.retrievalAccuracy - speedPreset.qualityMetrics.retrievalAccuracy;
      const speedLoss = qualityPreset.queryMetrics.averageRetrievalTime - speedPreset.queryMetrics.averageRetrievalTime;
      
      if (qualityGain > 0.1 && speedLoss < 200) {
        recommendations.push('The quality improvements are significant with minimal speed impact - consider using quality preset');
      }
    }
    
    recommendations.push('Use the "balanced" preset for general-purpose applications');
    recommendations.push('Consider creating custom presets based on your specific use case requirements');
    
    return recommendations;
  }

  private printSummary(results: BenchmarkResult[], comparison: any): void {
    console.log('\n=== OPTIMIZATION BENCHMARK RESULTS ===\n');
    
    // Results table
    console.log('📈 Performance Metrics:');
    console.log('Preset'.padEnd(12) + 'Retrieval(ms)'.padEnd(15) + 'Accuracy'.padEnd(10) + 'Quality'.padEnd(10) + 'Memory(MB)'.padEnd(12));
    console.log('-'.repeat(70));
    
    for (const result of results) {
      const retrievalTime = Math.round(result.queryMetrics.averageRetrievalTime);
      const accuracy = (result.qualityMetrics.retrievalAccuracy * 100).toFixed(1) + '%';
      const quality = (result.qualityMetrics.chunkQuality * 100).toFixed(1) + '%';
      const memory = Math.round(result.memoryUsage / (1024 * 1024));
      
      console.log(
        result.preset.padEnd(12) +
        retrievalTime.toString().padEnd(15) +
        accuracy.padEnd(10) +
        quality.padEnd(10) +
        memory.toString().padEnd(12)
      );
    }
    
    console.log('\n🏆 Winners:');
    console.log(`⚡ Fastest: ${comparison.fastest}`);
    console.log(`🎯 Most Accurate: ${comparison.mostAccurate}`);
    console.log(`⚖️  Best Balanced: ${comparison.bestBalanced}`);
    
    console.log('\n💡 Recommendations:');
    comparison.recommendations.forEach((rec: string, idx: number) => {
      console.log(`${idx + 1}. ${rec}`);
    });
  }

  // Individual component testing methods
  async testChunkingPerformance(): Promise<void> {
    console.log('\n🧩 Testing chunking strategies...');
    // Implementation for specific chunking tests
  }

  async testEmbeddingQuality(): Promise<void> {
    console.log('\n🔢 Testing embedding quality...');
    // Implementation for specific embedding tests
  }

  async testRetrievalAccuracy(): Promise<void> {
    console.log('\n🔍 Testing retrieval accuracy...');
    // Implementation for specific retrieval tests
  }
}

// Export for use in test scripts
export async function runBenchmark(): Promise<void> {
  const benchmark = new OptimizationBenchmark();
  await benchmark.runComprehensiveBenchmark();
}

// Command line interface
if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmark().catch(console.error);
}