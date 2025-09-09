import type { OptimizedPipelineConfig } from '../retrieval/optimized-pipeline.js';

// Performance-focused preset for production workloads
export const PERFORMANCE_PRESET: OptimizedPipelineConfig = {
  chunkingStrategy: 'semantic',
  embeddingStrategy: 'enhanced',
  retrievalStrategy: 'advanced',
  
  chunking: {
    targetChunkSize: 512,
    overlap: 64,
    maxChunkSize: 768,
    // Semantic chunking settings
    semanticThreshold: 0.75,
    preserveStructure: true,
    minChunkWords: 50,
    maxChunkWords: 200,
    contextWindow: 20,
    enableHierarchical: true
  },
  
  embedding: {
    enableDocumentLevelEmbedding: true,
    enableSectionLevelEmbedding: true,
    enableChunkLevelEmbedding: true,
    contextWindowSize: 50,
    includeHierarchicalContext: true,
    enableSparseEmbeddings: true,
    denseWeight: 0.7,
    sparseWeight: 0.3,
    enableQueryExpansion: true,
    maxQueryVariants: 3,
    enableTitleWeighting: true,
    titleWeight: 2,
    enableMetadataEmbedding: true
  },
  
  retrieval: {
    enableTwoStageRetrieval: true,
    initialK: 20,
    finalK: 10,
    enableHyDE: true,
    enableQueryExpansion: true,
    maxQueryVariants: 5,
    expansionWeight: 0.8,
    enableContextualCompression: true,
    compressionThreshold: 0.6,
    enableMMR: true,
    mmrLambda: 0.7,
    enableCrossEncoderRerank: false, // Disabled for performance
    enableTemporalScoring: true,
    temporalWeight: 0.1,
    enableMetadataFiltering: true,
    metadataBoosts: {
      hasCode: 0.2,
      hasTables: 0.1,
      hasLists: 0.05
    }
  },
  
  vectorStore: {
    enableMultipleSpaces: true,
    spaceConfigs: {
      default: {
        description: 'General purpose document space',
        embeddingDimension: 384, // Typical for sentence transformers
        distanceFunction: 'cosine',
        indexType: 'hnsw'
      },
      code: {
        description: 'Code-focused document space',
        embeddingDimension: 384,
        distanceFunction: 'cosine',
        indexType: 'hnsw'
      }
    },
    enableAdaptiveK: true,
    minK: 5,
    maxK: 50,
    adaptiveThreshold: 0.8,
    enableAdvancedFiltering: true,
    indexedMetadataFields: ['pageId', 'space', 'hasCode', 'hasTables', 'level'],
    enableHybridSearch: true,
    denseWeight: 0.7,
    sparseWeight: 0.3,
    enableBatching: true,
    batchSize: 100,
    enableCaching: true,
    cacheSize: 1000
  },
  
  enableParallelProcessing: true,
  maxConcurrentEmbeddings: 5,
  processingTimeout: 30000,
  enableQualityMetrics: true,
  minChunkQualityScore: 0.6,
  enableContentFiltering: true
};

// Quality-focused preset for maximum accuracy
export const QUALITY_PRESET: OptimizedPipelineConfig = {
  ...PERFORMANCE_PRESET,
  
  chunking: {
    ...PERFORMANCE_PRESET.chunking,
    semanticThreshold: 0.85,
    contextWindow: 30,
    minChunkWords: 75
  },
  
  embedding: {
    ...PERFORMANCE_PRESET.embedding,
    contextWindowSize: 75,
    maxQueryVariants: 5,
    titleWeight: 3
  },
  
  retrieval: {
    ...PERFORMANCE_PRESET.retrieval,
    initialK: 30,
    finalK: 15,
    enableCrossEncoderRerank: true,
    compressionThreshold: 0.7,
    mmrLambda: 0.8,
    maxQueryVariants: 7,
    temporalWeight: 0.05
  },
  
  vectorStore: {
    ...PERFORMANCE_PRESET.vectorStore,
    adaptiveThreshold: 0.85,
    maxK: 75,
    cacheSize: 2000
  },
  
  maxConcurrentEmbeddings: 3, // Lower for quality
  minChunkQualityScore: 0.75
};

// Speed-focused preset for development and testing
export const SPEED_PRESET: OptimizedPipelineConfig = {
  chunkingStrategy: 'simple',
  embeddingStrategy: 'enhanced',
  retrievalStrategy: 'basic',
  
  chunking: {
    targetChunkSize: 256,
    overlap: 32,
    maxChunkSize: 512
  },
  
  embedding: {
    enableDocumentLevelEmbedding: false,
    enableSectionLevelEmbedding: true,
    enableChunkLevelEmbedding: true,
    contextWindowSize: 25,
    includeHierarchicalContext: false,
    enableSparseEmbeddings: false,
    denseWeight: 1.0,
    sparseWeight: 0.0,
    enableQueryExpansion: false,
    maxQueryVariants: 1,
    enableTitleWeighting: false,
    titleWeight: 1,
    enableMetadataEmbedding: false
  },
  
  retrieval: {
    enableTwoStageRetrieval: false,
    initialK: 10,
    finalK: 10,
    enableHyDE: false,
    enableQueryExpansion: false,
    maxQueryVariants: 1,
    expansionWeight: 1.0,
    enableContextualCompression: false,
    compressionThreshold: 0.5,
    enableMMR: false,
    mmrLambda: 1.0,
    enableCrossEncoderRerank: false,
    enableTemporalScoring: false,
    temporalWeight: 0.0,
    enableMetadataFiltering: false
  },
  
  vectorStore: {
    enableMultipleSpaces: false,
    spaceConfigs: {
      default: {
        description: 'Simple default space',
        embeddingDimension: 384,
        distanceFunction: 'cosine',
        indexType: 'flat'
      }
    },
    enableAdaptiveK: false,
    minK: 5,
    maxK: 20,
    adaptiveThreshold: 0.7,
    enableAdvancedFiltering: false,
    indexedMetadataFields: ['pageId'],
    enableHybridSearch: false,
    denseWeight: 1.0,
    sparseWeight: 0.0,
    enableBatching: true,
    batchSize: 50,
    enableCaching: true,
    cacheSize: 500
  },
  
  enableParallelProcessing: true,
  maxConcurrentEmbeddings: 10,
  processingTimeout: 15000,
  enableQualityMetrics: false,
  minChunkQualityScore: 0.4,
  enableContentFiltering: false
};

// Balanced preset for general use
export const BALANCED_PRESET: OptimizedPipelineConfig = {
  chunkingStrategy: 'semantic',
  embeddingStrategy: 'enhanced',
  retrievalStrategy: 'advanced',
  
  chunking: {
    targetChunkSize: 400,
    overlap: 50,
    maxChunkSize: 600,
    semanticThreshold: 0.8,
    preserveStructure: true,
    minChunkWords: 60,
    maxChunkWords: 150,
    contextWindow: 25,
    enableHierarchical: true
  },
  
  embedding: {
    enableDocumentLevelEmbedding: false, // Disabled for balance
    enableSectionLevelEmbedding: true,
    enableChunkLevelEmbedding: true,
    contextWindowSize: 40,
    includeHierarchicalContext: true,
    enableSparseEmbeddings: true,
    denseWeight: 0.75,
    sparseWeight: 0.25,
    enableQueryExpansion: true,
    maxQueryVariants: 3,
    enableTitleWeighting: true,
    titleWeight: 2,
    enableMetadataEmbedding: true
  },
  
  retrieval: {
    enableTwoStageRetrieval: true,
    initialK: 15,
    finalK: 10,
    enableHyDE: false, // Disabled for balance
    enableQueryExpansion: true,
    maxQueryVariants: 4,
    expansionWeight: 0.8,
    enableContextualCompression: true,
    compressionThreshold: 0.65,
    enableMMR: true,
    mmrLambda: 0.7,
    enableCrossEncoderRerank: false,
    enableTemporalScoring: true,
    temporalWeight: 0.08,
    enableMetadataFiltering: true,
    metadataBoosts: {
      hasCode: 0.15
    }
  },
  
  vectorStore: {
    enableMultipleSpaces: false,
    spaceConfigs: {
      default: {
        description: 'Balanced default space',
        embeddingDimension: 384,
        distanceFunction: 'cosine',
        indexType: 'hnsw'
      }
    },
    enableAdaptiveK: true,
    minK: 5,
    maxK: 30,
    adaptiveThreshold: 0.75,
    enableAdvancedFiltering: true,
    indexedMetadataFields: ['pageId', 'space', 'hasCode', 'level'],
    enableHybridSearch: true,
    denseWeight: 0.75,
    sparseWeight: 0.25,
    enableBatching: true,
    batchSize: 75,
    enableCaching: true,
    cacheSize: 750
  },
  
  enableParallelProcessing: true,
  maxConcurrentEmbeddings: 4,
  processingTimeout: 25000,
  enableQualityMetrics: true,
  minChunkQualityScore: 0.5,
  enableContentFiltering: true
};

export const OPTIMIZATION_PRESETS = {
  performance: PERFORMANCE_PRESET,
  quality: QUALITY_PRESET,
  speed: SPEED_PRESET,
  balanced: BALANCED_PRESET,
  // Stability-focused preset: minimize variance by disabling
  // expansion, HyDE, MMR, and compression; fixed K; dense-only scoring.
  stable: {
    chunkingStrategy: BALANCED_PRESET.chunkingStrategy,
    embeddingStrategy: BALANCED_PRESET.embeddingStrategy,
    retrievalStrategy: 'advanced' as const,

    chunking: { ...BALANCED_PRESET.chunking },

    embedding: {
      ...BALANCED_PRESET.embedding,
      enableSparseEmbeddings: false,
      denseWeight: 1.0,
      sparseWeight: 0.0,
      enableQueryExpansion: false,
      maxQueryVariants: 1
    },

    retrieval: {
      ...BALANCED_PRESET.retrieval,
      enableTwoStageRetrieval: false,
      initialK: 20,
      finalK: 10,
      enableHyDE: false,
      enableQueryExpansion: false,
      maxQueryVariants: 1,
      expansionWeight: 0.5,
      enableContextualCompression: false,
      enableMMR: false,
      enableCrossEncoderRerank: false,
      enableTemporalScoring: false,
      enableMetadataFiltering: true
    },

    vectorStore: {
      ...BALANCED_PRESET.vectorStore,
      enableAdaptiveK: false,
      minK: 10,
      maxK: 20,
      enableHybridSearch: false,
      denseWeight: 1.0,
      sparseWeight: 0.0,
      enableBatching: true,
      batchSize: BALANCED_PRESET.vectorStore.batchSize,
      enableCaching: true,
      cacheSize: BALANCED_PRESET.vectorStore.cacheSize
    },

    enableParallelProcessing: true,
    maxConcurrentEmbeddings: BALANCED_PRESET.maxConcurrentEmbeddings,
    processingTimeout: BALANCED_PRESET.processingTimeout,
    enableQualityMetrics: false,
    minChunkQualityScore: BALANCED_PRESET.minChunkQualityScore,
    enableContentFiltering: true
  }
};

export type PresetName = keyof typeof OPTIMIZATION_PRESETS;

export function getPreset(name: PresetName): OptimizedPipelineConfig {
  return OPTIMIZATION_PRESETS[name];
}

// Utility type for deep partial overrides
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export function createCustomPreset(
  baseName: PresetName,
  overrides: DeepPartial<OptimizedPipelineConfig>
): OptimizedPipelineConfig {
  const basePreset = getPreset(baseName);
  return {
    ...basePreset,
    ...overrides,
    chunking: { ...basePreset.chunking, ...(overrides.chunking || {}) } as OptimizedPipelineConfig['chunking'],
    embedding: { ...basePreset.embedding, ...(overrides.embedding || {}) } as OptimizedPipelineConfig['embedding'],
    retrieval: { ...basePreset.retrieval, ...(overrides.retrieval || {}) } as OptimizedPipelineConfig['retrieval'],
    vectorStore: { ...basePreset.vectorStore, ...(overrides.vectorStore || {}) } as OptimizedPipelineConfig['vectorStore']
  };
}
