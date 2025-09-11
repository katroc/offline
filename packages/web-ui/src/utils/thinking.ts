// Utilities for handling reasoning/thinking content returned by some models

// Strip all <think>...</think> blocks from a string
export function stripThinking(input: string): string {
  if (!input) return '';
  try {
    const rawPattern = /<think(?:\s[^>]*)?>[\s\S]*?<\/think>\s*/gi;
    const escPattern = /&lt;think(?:\s[^&]*)&gt;[\s\S]*?&lt;\/think&gt;\s*/gi;
    return input.replace(rawPattern, '').replace(escPattern, '').trim();
  } catch {
    return input;
  }
}

// Extract thinking blocks and the visible answer separately
export function splitThinking(input: string): { thinking: string; answer: string } {
  if (!input) return { thinking: '', answer: '' };
  const parts: string[] = [];

  // Raw blocks (allow attributes/whitespace)
  const raw = /<think(?:\s[^>]*)?>([\s\S]*?)<\/think>/gi;
  let m: RegExpExecArray | null;
  while ((m = raw.exec(input)) !== null) {
    if (m[1]) parts.push(m[1].trim());
  }

  // Escaped blocks (allow attributes/whitespace)
  const esc = /&lt;think(?:\s[^&]*)&gt;([\s\S]*?)&lt;\/think&gt;/gi;
  while ((m = esc.exec(input)) !== null) {
    if (m[1]) {
      const unescaped = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      parts.push(unescaped);
    }
  }

  const answer = stripThinking(input);
  const thinking = parts.join('\n\n');
  return { thinking, answer };
}

// Quick detector
export function hasThinking(input: string): boolean {
  const s = input || '';
  return /<think>[\s\S]*?<\/think>/.test(s) || /&lt;think&gt;[\s\S]*?&lt;\/think&gt;/.test(s);
}
