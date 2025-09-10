import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { Icon } from './components/Icon';

// Small helper for copy-to-clipboard with inline feedback
const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      // noop; we could surface an error toast in future
    }
  };

  return (
    <div className="copy-controls">
      <button 
        className="copy-button"
        onClick={handleCopy}
        title={copied ? 'Copied' : 'Copy code'}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Icon name="check-circle" size={14} /> : <Icon name="clipboard" />}
      </button>
      {copied && <span className="copy-toast" role="status">Copied</span>}
    </div>
  );
};

interface Citation {
  pageId: string;
  title: string;
  url: string;
  sectionAnchor?: string;
  snippet?: string;
}

interface SmartResponseProps {
  answer: string;
  citations: Citation[];
  displayCitations?: Citation[];
  citationIndexMap?: number[];
  usedCitationIndexes?: number[]; // display indices (1-based) from server
  query: string;
  animate?: boolean;
}

type QueryType = 'factual' | 'howto' | 'troubleshooting' | 'comparison' | 'general';

interface ResponseSection {
  type: string;
  content: string;
  icon?: string;
}

export const SmartResponse: React.FC<SmartResponseProps> = ({ answer, citations, displayCitations, citationIndexMap, usedCitationIndexes, query, animate = false }) => {
  const [activeCitation, setActiveCitation] = React.useState<number | null>(null);
  const hoverTimeoutRef = React.useRef<number | null>(null);
  const citationRefs = React.useRef<Record<number, HTMLDivElement | null>>({});
  const [displayedAnswer, setDisplayedAnswer] = React.useState(animate ? '' : answer);
  const [isAnimating, setIsAnimating] = React.useState(animate);

  const clearHoverTimeout = () => {
    if (hoverTimeoutRef.current) {
      window.clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  };

  // Animation effect
  React.useEffect(() => {
    if (!animate || !answer) {
      setDisplayedAnswer(answer);
      setIsAnimating(false);
      return;
    }

    setDisplayedAnswer('');
    setIsAnimating(true);
    
    let currentIndex = 0;
    const speed = 30; // milliseconds per chunk
    const chunkSize = 8; // characters per chunk
    
    const interval = setInterval(() => {
      if (currentIndex >= answer.length) {
        setDisplayedAnswer(answer);
        setIsAnimating(false);
        clearInterval(interval);
        return;
      }

      // Reveal text in chunks
      currentIndex = Math.min(currentIndex + chunkSize, answer.length);
      setDisplayedAnswer(answer.slice(0, currentIndex));
    }, speed);

    return () => clearInterval(interval);
  }, [answer, animate]);

  const focusCitation = (num: number) => {
    const el = citationRefs.current[num];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      setActiveCitation(num);
      clearHoverTimeout();
      hoverTimeoutRef.current = window.setTimeout(() => setActiveCitation(null), 1600);
    }
  };
  
  // Extract referenced citation numbers from the answer text (map to display indices if provided)
  const getReferencedCitations = (text: string, allCitations: Citation[], renderList: Citation[]): Citation[] => {
    const citationPattern = /\[(\d+)\]/g;
    const referencedNumbers = new Set<number>();
    let match;
    
    while ((match = citationPattern.exec(text)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num <= allCitations.length) {
        referencedNumbers.add(num);
      }
    }
    
    // If we have a mapping to a display list, convert to the display indices
    const toDisplay = (n: number): number => {
      const idx0 = n - 1;
      if (citationIndexMap && idx0 >= 0 && idx0 < citationIndexMap.length) {
        const mapped = citationIndexMap[idx0];
        if (typeof mapped === 'number' && mapped >= 0 && mapped < renderList.length) return mapped + 1;
      }
      return n; // fallback
    };

    const displaySet = new Set<number>();
    for (const n of referencedNumbers) displaySet.add(toDisplay(n));

    return Array.from(displaySet)
      .sort((a, b) => a - b)
      .map(num => renderList[num - 1])
      .filter(Boolean);
  };

  // Wrap bracketed numeric references like [1] with a citation pill span
  const wrapCitationRefs = (node: any): any => {
    if (typeof node === 'string') {
      // Normalize duplicates like [1][1] or [1] 1 -> [1]
      let normalized = node
        .replace(/\[(\d+)\]\s*\[\1\]/g, '[$1]')
        .replace(/\[(\d+)\](\s*\1)(?!\d)/g, '[$1]');

      // Only consider bracketed numbers that aren't immediately followed by another digit
      if (/\[(\d+)\]/.test(normalized)) {
        // Replace each [n] with citation pill
        const result: any[] = [];
        let lastIndex = 0;
        const citationRegex = /\[(\d+)\]/g;
        let match;

        while ((match = citationRegex.exec(normalized)) !== null) {
          const num = parseInt(match[1], 10);
          
          // Add any text before the citation
          if (match.index > lastIndex) {
            const beforeText = normalized.substring(lastIndex, match.index);
            if (beforeText.trim() !== '') {
              result.push(beforeText);
            }
          }

          // Only render a pill if this number exists in the citations list
          if (num > 0 && num <= citations.length) {
            // Map to display number if provided
            let displayNum = num;
            if (citationIndexMap && citationIndexMap[num - 1] !== undefined) {
              displayNum = citationIndexMap[num - 1] + 1;
            }
            const renderList = (displayCitations && displayCitations.length > 0) ? displayCitations : citations;
            const citation = renderList[displayNum - 1] || citations[num - 1];
            const title = citation?.title || `Source ${num}`;
            const onKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                focusCitation(displayNum);
              }
            };
            result.push(
              <span
                key={`cite-${num}-${match.index}`}
                className={`citation-ref${activeCitation === displayNum ? ' active' : ''}`}
                data-cite={displayNum}
                role="button"
                tabIndex={0}
                aria-label={`View source ${displayNum}: ${title}`}
                onClick={() => focusCitation(displayNum)}
                onKeyDown={onKeyDown}
                onMouseEnter={() => setActiveCitation(displayNum)}
                onMouseLeave={() => setActiveCitation(null)}
              >
                {displayNum}
              </span>
            );
          }
          // If invalid citation number, we skip it (don't add anything)

          lastIndex = match.index + match[0].length;
        }

        // Add any remaining text after the last citation
        if (lastIndex < normalized.length) {
          const afterText = normalized.substring(lastIndex);
          if (afterText.trim() !== '') {
            result.push(afterText);
          }
        }

        return result.length > 0 ? result : normalized;
      }
      return normalized;
    }
    if (React.isValidElement(node) && (node.props as any)?.children) {
      return React.cloneElement(node, {
        children: React.Children.map((node.props as any).children, wrapCitationRefs)
      } as any);
    }
    return node;
  };

  // Post-process sibling nodes: remove a leading duplicate number that
  // immediately follows a citation pill (handles cross-node duplicates).
  const dedupeAdjacentCitationDigits = (nodes: any[]): any[] => {
    const out: any[] = [];
    let lastCite: number | null = null;
    for (const n of nodes) {
      if (React.isValidElement(n) && (n.props as any)?.className === 'citation-ref') {
        const t = Array.isArray((n.props as any).children) ? (n.props as any).children.join('') : String((n.props as any).children ?? '');
        const num = parseInt(t, 10);
        if (!Number.isNaN(num)) {
          lastCite = num;
        } else {
          lastCite = null;
        }
        out.push(n);
        continue;
      }
      if (typeof n === 'string' && lastCite !== null) {
        // Strip a leading duplicate like " 1" or "\u00A01" optionally before punctuation
        const re = new RegExp(`^\\s*${lastCite}(?=[^\\d])`);
        const replaced = n.replace(re, '');
        out.push(replaced);
        // Only dedupe once for the immediate sibling
        lastCite = null;
        continue;
      }
      // Reset if we encounter any other node
      lastCite = null;
      out.push(n);
    }
    return out;
  };

  // (Deprecated) client-side dedupe removed to enforce a single method.

  // Utility to map children -> wrap citation refs -> dedupe adjacent digits
  const processChildrenWithCitations = (children: any): any => {
    const arr = React.Children.toArray(children).map((n: any) => wrapCitationRefs(n));
    const flat: any[] = [];
    for (const n of arr) {
      if (Array.isArray(n)) flat.push(...n); else flat.push(n);
    }
    return dedupeAdjacentCitationDigits(flat);
  };

  // Detect query type based on patterns
  const detectQueryType = (query: string): QueryType => {
    const q = query.toLowerCase();
    
    if (q.includes('how to') || q.includes('how do') || q.includes('how can')) {
      return 'howto';
    }
    
    if (q.includes('issue') || q.includes('problem') || q.includes('error') || q.includes('fix') || q.includes('troubleshoot')) {
      return 'troubleshooting';
    }
    
    if (q.includes('difference') || q.includes('compare') || q.includes('vs') || q.includes('versus')) {
      return 'comparison';
    }
    
    if (q.includes('what is') || q.includes('what are') || q.includes('define') || q.includes('explain')) {
      return 'factual';
    }
    
    return 'general';
  };

  // Parse and structure the response based on type
  const parseResponse = (answer: string, type: QueryType): ResponseSection[] => {
    const sections: ResponseSection[] = [];
    
    // For troubleshooting, look for problem/solution structure
    if (type === 'troubleshooting') {
      const lines = answer.split('\n');
      let currentSection = '';
      let currentContent: string[] = [];
      
      for (const line of lines) {
        if (line.toLowerCase().includes('problem:') || line.toLowerCase().includes('issue:')) {
          if (currentSection) {
            sections.push({ type: currentSection, content: currentContent.join('\n') });
          }
          currentSection = 'problem';
          currentContent = [line];
        } else if (line.toLowerCase().includes('solution:') || line.toLowerCase().includes('fix:')) {
          if (currentSection) {
            sections.push({ type: currentSection, content: currentContent.join('\n') });
          }
          currentSection = 'solution';
          currentContent = [line];
        } else {
          currentContent.push(line);
        }
      }
      
      if (currentSection) {
        sections.push({ type: currentSection, content: currentContent.join('\n') });
      }
    }
    
    // If no special structure detected, return as single section
    if (sections.length === 0) {
      sections.push({ type: 'main', content: answer });
    }
    
    return sections;
  };

  // Get icon for section type
  const getSectionIcon = (type: string): React.ReactNode => {
    switch (type) {
      case 'problem': return <Icon name="alert" size={16} />;
      case 'solution': return <Icon name="check-circle" size={16} />;
      case 'warning': return <Icon name="bolt" size={16} />;
      case 'tip': return <Icon name="bulb" size={16} />;
      case 'step': return <Icon name="clipboard" size={16} />;
      default: return null;
    }
  };

  // Get appropriate wrapper class for query type
  const getResponseClass = (type: QueryType): string => {
    switch (type) {
      case 'troubleshooting': return 'response-troubleshooting';
      case 'howto': return 'response-howto';
      case 'factual': return 'response-factual';
      case 'comparison': return 'response-comparison';
      default: return 'response-general';
    }
  };


  const queryType = detectQueryType(query);
  const sections = parseResponse(displayedAnswer, queryType);
  const renderBaseList = (displayCitations && displayCitations.length > 0) ? displayCitations : citations;
  const referencedCitations = (() => {
    // Prefer server-provided used indices for a single source of truth
    if (Array.isArray(usedCitationIndexes) && usedCitationIndexes.length > 0) {
      const uniq = Array.from(new Set(usedCitationIndexes.filter(n => Number.isFinite(n) && n >= 1 && n <= renderBaseList.length))).sort((a, b) => a - b);
      return uniq.map(n => renderBaseList[n - 1]).filter(Boolean);
    }
    // Fallback: parse client-side from text
    return getReferencedCitations(displayedAnswer, citations, renderBaseList);
  })();
  // Only show sources that are directly cited in the answer (no fallback to all)

  return (
    <div className={`smart-response ${getResponseClass(queryType)}`}>
      {/* Query type indicator */}
      <div className="response-type-indicator">
        {queryType === 'howto' && (
          <span className="type-badge"><Icon name="clipboard" size={14} /> <span>How-to</span></span>
        )}
        {queryType === 'troubleshooting' && (
          <span className="type-badge"><Icon name="tools" size={14} /> <span>Troubleshooting</span></span>
        )}
        {queryType === 'factual' && (
          <span className="type-badge"><Icon name="info" size={14} /> <span>Information</span></span>
        )}
        {queryType === 'comparison' && (
          <span className="type-badge"><Icon name="scale" size={14} /> <span>Comparison</span></span>
        )}
      </div>

      {/* Main content */}
      <div className="response-content">
        {sections.map((section, index) => (
          <div key={index} className={`response-section section-${section.type}`}>
            {section.type !== 'main' && (
              <div className="section-header">
                <span className="section-icon">{getSectionIcon(section.type)}</span>
                <span className="section-title">{section.type.toUpperCase()}</span>
              </div>
            )}
            <div className="section-body">
              <ReactMarkdown 
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight, rehypeRaw]}
                components={{
                  // Custom rendering for different elements
                  code: ({ node, inline, className, children, ...props }: any) => {
                    const match = /language-(\w+)/.exec(className || '');
                    const lang = match ? match[1] : '';
                    
                    if (inline) {
                      return <code className="inline-code" {...props}>{children}</code>;
                    }
                    
                    return (
                      <div className="code-block-wrapper">
                        {lang && <div className="code-lang">{lang}</div>}
                        <pre className={className}>
                          <code {...props}>{children}</code>
                        </pre>
                        <CopyButton text={String(children)} />
                      </div>
                    );
                  },
                  
                  // Normalize citation references across common block/inline elements
                  p: ({ children }) => <p>{processChildrenWithCitations(children)}</p>,
                  
                  // Enhanced list rendering
                  ol: ({ children }) => <ol className="ordered-list">{children}</ol>,
                  ul: ({ children }) => <ul className="unordered-list">{children}</ul>,
                  li: ({ children }) => <li className="list-item">{processChildrenWithCitations(children)}</li>,
                  
                  // Enhanced headings
                  h1: ({ children }) => <h1 className="response-h1">{processChildrenWithCitations(children)}</h1>,
                  h2: ({ children }) => <h2 className="response-h2">{processChildrenWithCitations(children)}</h2>,
                  h3: ({ children }) => <h3 className="response-h3">{processChildrenWithCitations(children)}</h3>,
                  
                  // Enhanced emphasis
                  strong: ({ children }) => <strong className="text-bold">{React.Children.map(children, wrapCitationRefs)}</strong>,
                  em: ({ children }) => <em className="text-italic">{children}</em>,
                  
                  // Blockquotes as callouts
                  blockquote: ({ children }) => (
                    <div className="callout callout-info">
                      <div className="callout-icon"><Icon name="info" size={16} /></div>
                      <div className="callout-content">{processChildrenWithCitations(children)}</div>
                    </div>
                  ),
                  
                  // Enhanced links
                  a: ({ href, children }) => (
                    <a href={href} className="response-link" target="_blank" rel="noopener noreferrer">
                      {children}
                      <span className="link-icon"><Icon name="external-link" size={14} /></span>
                    </a>
                  ),
                  
                  // Enhanced table rendering
                  table: ({ children }) => (
                    <div className="table-wrapper">
                      <table className="response-table">{children}</table>
                    </div>
                  ),
                  thead: ({ children }) => <thead className="table-head">{children}</thead>,
                  tbody: ({ children }) => <tbody className="table-body">{children}</tbody>,
                  tr: ({ children }) => <tr className="table-row">{children}</tr>,
                  th: ({ children }) => <th className="table-header">{processChildrenWithCitations(children)}</th>,
                  td: ({ children }) => <td className="table-cell">{processChildrenWithCitations(children)}</td>,
                }}
              >
                {section.content}
              </ReactMarkdown>
              {isAnimating && index === sections.length - 1 && (
                <span className="typewriter-cursor">▊</span>
              )}
            </div>
          </div>
        ))}
      </div>


      {/* Citations section - show referenced citations, fallback to all if none referenced */}
      {referencedCitations.length > 0 && (
        <div className="citations-section">
          <h3 className="citations-header"><Icon name="stack" size={16} /> <span>Sources</span></h3>
          <div className="citations-list">
            {(() => {
              // Single, consistent method:
              // Use server-provided displayCitations if present; otherwise fall back to raw citations without client-side dedupe.
              const renderList = (displayCitations && displayCitations.length > 0) ? displayCitations : citations;
              const list = referencedCitations;
              return list.map((citation) => {
                const displayNumber = renderList.indexOf(citation) + 1;
                const num = displayNumber > 0 ? displayNumber : (citations.indexOf(citation) + 1);
                return (
                  <div
                    key={`${citation.pageId}-${num}`}
                    className={`citation-item${activeCitation === num ? ' active' : ''}`}
                    ref={(el) => { citationRefs.current[num] = el; }}
                    id={`source-${num}`}
                  >
                    <span className="citation-number">{num}</span>
                    <a 
                      href={citation.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="citation-link"
                      aria-label={`Open ${citation.title} in new tab`}
                    >
                      <span className="citation-title">{citation.title}</span>
                      {citation.sectionAnchor && (
                        <span className="citation-section">#{citation.sectionAnchor}</span>
                      )}
                    </a>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}
    </div>
  );
};
