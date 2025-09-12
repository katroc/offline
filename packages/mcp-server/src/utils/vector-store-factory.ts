import { fileURLToPath } from 'url';
import path from 'node:path';
import { LanceDBVectorStore, ChromaVectorStore, MockVectorStore } from '../retrieval/vector-store.js';
import type { VectorStore } from '../retrieval/vector-store.js';

export interface VectorStoreOptions {
  type?: 'chroma' | 'lancedb' | 'mock';
  useRealVectorDB?: boolean;
  tableName?: string;
}

/**
 * Factory function to create the appropriate vector store based on environment configuration
 * and optional overrides
 */
export async function createVectorStore(options: VectorStoreOptions = {}): Promise<VectorStore> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '../../../../');

  const useRealVectorDB = options.useRealVectorDB ?? (process.env.USE_REAL_VECTORDB === 'true');
  const vectorStoreType = (options.type || process.env.VECTOR_STORE_TYPE || 'lancedb').toLowerCase();
  
  if (!useRealVectorDB) {
    console.log('Using mock vector store (set USE_REAL_VECTORDB=true for real vector stores)');
    return new MockVectorStore();
  }

  if (vectorStoreType === 'chroma') {
    try {
      const host = process.env.CHROMA_HOST;
      const port = process.env.CHROMA_PORT ? parseInt(process.env.CHROMA_PORT, 10) : undefined;
      const ssl = process.env.CHROMA_SSL === 'true';
      const collectionName = process.env.CHROMA_COLLECTION || 'confluence_chunks';
      const authProvider = process.env.CHROMA_AUTH_PROVIDER || undefined;
      const authCredentials = process.env.CHROMA_AUTH_CREDENTIALS || undefined;

      const auth = (authProvider && authCredentials) ? {
        provider: authProvider as 'token' | 'basic',
        credentials: authCredentials
      } : undefined;

      const vectorStore = new ChromaVectorStore({
        host,
        port,
        ssl,
        collectionName,
        auth
      });
      
      console.log(`Initialized Chroma vector store at: ${host || 'localhost'}:${port || 8000}`);
      return vectorStore;
    } catch (error) {
      console.warn('Failed to initialize Chroma, falling back to mock store:', error);
      return new MockVectorStore();
    }
  } else {
    // Default to LanceDB
    try {
      const lanceEnv = process.env.LANCEDB_PATH || './data/lancedb';
      const lanceDbPath = path.isAbsolute(lanceEnv) ? lanceEnv : path.resolve(repoRoot, lanceEnv);
      const tableName = options.tableName || 'confluence_chunks';
      
      const vectorStore = new LanceDBVectorStore({
        dbPath: lanceDbPath,
        tableName
      });
      
      console.log(`Initialized LanceDB vector store at: ${lanceDbPath}`);
      return vectorStore;
    } catch (error) {
      console.warn('Failed to initialize LanceDB, falling back to mock store:', error);
      return new MockVectorStore();
    }
  }
}