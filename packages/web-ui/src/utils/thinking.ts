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

  // Handle orphan opening tag with no explicit close (raw or escaped)
  if (parts.length === 0) {
    const openRaw = /<think(?:\s[^>]*)?>/i;
    const openEsc = /&lt;think(?:\s[^&]*)&gt;/i;
    const openRawMatch = input.match(openRaw);
    const openEscMatch = input.match(openEsc);
    if (openRawMatch) {
      const start = input.search(openRaw);
      if (start >= 0) {
        const after = input.slice(start + openRawMatch[0].length);
        if (after.trim()) parts.push(after.trim());
      }
    } else if (openEscMatch) {
      const start = input.search(openEsc);
      if (start >= 0) {
        const after = input.slice(start + openEscMatch[0].length);
        const unescaped = after.replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        if (unescaped) parts.push(unescaped);
      }
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
