/**
 * QueryIntentProcessor - Normalizes user queries to improve retrieval consistency
 * 
 * Addresses issues where similar intents get different results due to:
 * - Literal keyword matching vs semantic intent understanding
 * - Inconsistent phrasing for the same underlying need
 * - Missing fallback strategies for poor initial retrieval
 */

export interface QueryNormalizationResult {
  originalQuery: string;
  normalizedQuery: string;
  intent: QueryIntent;
  confidence: number;
  fallbackQueries: string[];
}

export enum QueryIntent {
  HOW_TO = 'how_to',           // "how to delete X", "steps to configure Y"
  TROUBLESHOOT = 'troubleshoot', // "fix error", "why is X failing"
  FIND_LINK = 'find_link',     // "link to X", "URL for Y"
  DEFINITION = 'definition',    // "what is X", "explain Y"
  COMPARISON = 'comparison',    // "difference between X and Y"
  GENERAL = 'general'          // Catch-all for unclear intent
}

interface IntentPattern {
  pattern: RegExp;
  intent: QueryIntent;
  normalizer: (query: string, match: RegExpMatchArray) => string;
  confidence: number;
  generateFallbacks: (originalQuery: string, normalizedQuery: string) => string[];
}

export class QueryIntentProcessor {
  private patterns: IntentPattern[] = [
    // "link to X", "send me the link to X" → "how to X"
    {
      pattern: /(?:can you )?(?:send me )?(?:the )?link to (.+)/i,
      intent: QueryIntent.FIND_LINK,
      confidence: 0.9,
      normalizer: (query, match) => `how to ${match[1].trim()}`,
      generateFallbacks: (original, normalized) => {
        const subject = original.replace(/(?:can you )?(?:send me )?(?:the )?link to/i, '').trim();
        return [
          normalized,
          subject,
          `instructions for ${subject}`
        ];
      }
    },

    // "URL for X", "web address for X" → "how to X"
    {
      pattern: /(?:the )?(?:url|web address|website) for (.+)/i,
      intent: QueryIntent.FIND_LINK,
      confidence: 0.9,
      normalizer: (query, match) => `how to ${match[1].trim()}`,
      generateFallbacks: (original, normalized) => {
        const subject = original.replace(/(?:the )?(?:url|web address|website) for/i, '').trim();
        return [normalized, subject];
      }
    },

    // "how to X", "how do I X", "how can I X" → normalize variations
    {
      pattern: /how (?:to|do i|can i) (.+)/i,
      intent: QueryIntent.HOW_TO,
      confidence: 0.95,
      normalizer: (query, match) => `how to ${match[1].trim()}`,
      generateFallbacks: (original, normalized) => {
        const action = normalized.replace(/^how to\s+/i, '').trim();
        return [
          normalized,
          action,
          `${action} instructions`,
          `${action} guide`
        ];
      }
    },

    // "steps to X", "instructions for X" → "how to X"
    {
      pattern: /(?:steps to|instructions for|guide to) (.+)/i,
      intent: QueryIntent.HOW_TO,
      confidence: 0.9,
      normalizer: (query, match) => `how to ${match[1].trim()}`,
      generateFallbacks: (original, normalized) => {
        const action = normalized.replace(/^how to\s+/i, '').trim();
        return [
          normalized,
          action,
          `${action} tutorial`
        ];
      }
    },

    // Direct action queries: "delete X", "configure Y", "install Z"
    {
      pattern: /^(delete|remove|configure|install|setup|create|add|update|fix|restart|stop|start|enable|disable) (.+)/i,
      intent: QueryIntent.HOW_TO,
      confidence: 0.8,
      normalizer: (query, match) => `how to ${match[1].toLowerCase()} ${match[2].trim()}`,
      generateFallbacks: (original, normalized) => {
        const action = normalized.replace(/^how to\s+/i, '').trim();
        const parts = action.split(/\s+/);
        const verb = parts[0] || '';
        const obj = parts.slice(1).join(' ');
        return [
          original,
          normalized,
          `${verb} ${obj} guide`.trim(),
          `${obj} ${verb}`.trim()
        ];
      }
    },

    // Error/problem queries: "X error", "X not working", "issue with X"
    {
      pattern: /(.+) (?:error|not working|broken|issue|problem|failing)/i,
      intent: QueryIntent.TROUBLESHOOT,
      confidence: 0.8,
      normalizer: (query, match) => `troubleshoot ${match[1].trim()}`,
      generateFallbacks: (original, normalized) => {
        const target = normalized.replace(/^troubleshoot\s+/i, '').trim();
        return [
          original,
          normalized,
          `fix ${target}`,
          `${target} troubleshooting`
        ];
      }
    },

    // "why is X", "X won't work" → troubleshooting
    {
      pattern: /(?:why is|why does) (.+)|(.+) won't work/i,
      intent: QueryIntent.TROUBLESHOOT,
      confidence: 0.75,
      normalizer: (query, match) => {
        const target = (match[1] || match[2] || '').toString();
        return `troubleshoot ${target.trim()}`;
      },
      generateFallbacks: (original, normalized) => {
        const target = normalized.replace(/^troubleshoot\s+/i, '').trim();
        return [original, normalized, `fix ${target}`];
      }
    },

    // "what is X", "explain X", "define X"
    {
      pattern: /(?:what is|what are|explain|define) (.+)/i,
      intent: QueryIntent.DEFINITION,
      confidence: 0.9,
      normalizer: (query, match) => query, // Keep as-is for definitions
      generateFallbacks: (original, normalized) => {
        const subject = (original.match(/(?:what is|what are|explain|define)\s+(.+)/i)?.[1] || '').trim();
        const sub = subject || original;
        return [
          original,
          `${sub} overview`,
          `${sub} documentation`
        ];
      }
    },

    // "difference between X and Y", "X vs Y"
    {
      pattern: /(?:difference between|compare) (.+) (?:and|vs) (.+)|(.+) vs (.+)/i,
      intent: QueryIntent.COMPARISON,
      confidence: 0.9,
      normalizer: (query, match) => query, // Keep as-is for comparisons
      generateFallbacks: (original, normalized) => {
        const m = original.match(/(?:difference between|compare) (.+) (?:and|vs) (.+)|(.+) vs (.+)/i);
        const a = (m?.[1] || m?.[3] || '').trim();
        const b = (m?.[2] || m?.[4] || '').trim();
        const pairs: string[] = [];
        if (a) {pairs.push(`${a} comparison`);}
        if (b) {pairs.push(`${b} comparison`);}
        if (a && b) {pairs.push(`compare ${a} and ${b}`, `${a} vs ${b}`);}
        return [original, ...pairs];
      }
    }
  ];

  /**
   * Process a user query to determine intent and generate normalized variants
   */
  public processQuery(query: string): QueryNormalizationResult {
    const trimmedQuery = query.trim();
    
    // Try to match against known patterns
    for (const pattern of this.patterns) {
      const match = trimmedQuery.match(pattern.pattern);
      if (match) {
        const normalizedQuery = pattern.normalizer(trimmedQuery, match);
        const fallbackQueries = pattern.generateFallbacks(trimmedQuery, normalizedQuery);
        
        return {
          originalQuery: trimmedQuery,
          normalizedQuery,
          intent: pattern.intent,
          confidence: pattern.confidence,
          fallbackQueries: [...new Set(fallbackQueries)] // Dedupe
        };
      }
    }

    // No pattern matched - return as general query with basic fallbacks
    return {
      originalQuery: trimmedQuery,
      normalizedQuery: trimmedQuery,
      intent: QueryIntent.GENERAL,
      confidence: 0.5,
      fallbackQueries: [
        trimmedQuery,
        // Generate some basic semantic variations
        this.generateBasicFallbacks(trimmedQuery)
      ].flat()
    };
  }

  /**
   * Generate basic semantic fallbacks for unmatched queries
   */
  private generateBasicFallbacks(query: string): string[] {
    const fallbacks: string[] = [];
    
    // Remove common filler words and try that
    const cleaned = query.replace(/\b(please|can you|could you|would you|help me|i need to|i want to)\b/gi, '').trim();
    if (cleaned !== query && cleaned.length > 2) {
      fallbacks.push(cleaned);
    }

    // Add common action prefixes if the query seems to be asking for instructions
    if (this.looksLikeInstructionRequest(query)) {
      fallbacks.push(`how to ${cleaned || query}`);
      fallbacks.push(`${cleaned || query} guide`);
      fallbacks.push(`${cleaned || query} instructions`);
    }

    return [...new Set(fallbacks)];
  }

  /**
   * Heuristic to detect if a query is asking for instructions
   */
  private looksLikeInstructionRequest(query: string): boolean {
    const instructionIndicators = [
      /\b(help|guide|instruction|tutorial|step|process|procedure)\b/i,
      /\b(can|could|would|should) (you|i)\b/i,
      /\b(need to|want to|trying to)\b/i
    ];

    return instructionIndicators.some(pattern => pattern.test(query));
  }

  /**
   * Get human-readable intent description
   */
  public getIntentDescription(intent: QueryIntent): string {
    switch (intent) {
      case QueryIntent.HOW_TO: return 'How-to/Instructions';
      case QueryIntent.TROUBLESHOOT: return 'Troubleshooting';
      case QueryIntent.FIND_LINK: return 'Finding Links/URLs';
      case QueryIntent.DEFINITION: return 'Definition/Explanation';
      case QueryIntent.COMPARISON: return 'Comparison';
      case QueryIntent.GENERAL: return 'General Query';
    }
  }
}
