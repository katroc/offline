import { ConfluenceClient } from '../sources/confluence.js';

/**
 * Factory function to create a configured ConfluenceClient instance
 * Uses environment variables for configuration with sensible defaults
 */
export function createConfluenceClient(): ConfluenceClient {
  return new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL || 'https://confluence.local',
    username: process.env.CONFLUENCE_USERNAME || '',
    apiToken: process.env.CONFLUENCE_API_TOKEN || ''
  });
}