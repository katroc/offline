import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';

interface Citation {
  pageId: string;
  title: string;
  url: string;
  sectionAnchor?: string;
}

interface SmartResponseProps {
  answer: string;
  citations: Citation[];
  query: string;
}

type QueryType = 'factual' | 'howto' | 'troubleshooting' | 'comparison' | 'general';

interface ResponseSection {
  type: string;
  content: string;
  icon?: string;
}

export const SmartResponse: React.FC<SmartResponseProps> = ({ answer, citations, query }) => {
  
  // Extract referenced citation numbers from the answer text
  const getReferencedCitations = (text: string, allCitations: Citation[]): Citation[] => {
    const citationPattern = /\[(\d+)\]/g;
    const referencedNumbers = new Set<number>();
    let match;
    
    while ((match = citationPattern.exec(text)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num <= allCitations.length) {
        referencedNumbers.add(num);
      }
    }
    
    // Return only citations that are actually referenced
    return Array.from(referencedNumbers)
      .sort((a, b) => a - b)
      .map(num => allCitations[num - 1])
      .filter(Boolean);
  };

  // Pre-process content to add custom markers for citation references
  const preprocessContentForCitations = (content: string): string => {
    return content.replace(/\[(\d+)\]/g, '**[CITE:$1]**');
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
  const getSectionIcon = (type: string): string => {
    switch (type) {
      case 'problem': return '⚠️';
      case 'solution': return '✅';
      case 'warning': return '⚡';
      case 'tip': return '💡';
      case 'step': return '👉';
      default: return '';
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
  const sections = parseResponse(answer, queryType);
  const referencedCitations = getReferencedCitations(answer, citations);

  return (
    <div className={`smart-response ${getResponseClass(queryType)}`}>
      {/* Query type indicator */}
      <div className="response-type-indicator">
        {queryType === 'howto' && <span className="type-badge">📋 How-to</span>}
        {queryType === 'troubleshooting' && <span className="type-badge">🔧 Troubleshooting</span>}
        {queryType === 'factual' && <span className="type-badge">💭 Information</span>}
        {queryType === 'comparison' && <span className="type-badge">⚖️ Comparison</span>}
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
                  code: ({ node, inline, className, children, ...props }) => {
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
                        <button 
                          className="copy-button"
                          onClick={() => navigator.clipboard.writeText(String(children))}
                          title="Copy code"
                        >
                          📋
                        </button>
                      </div>
                    );
                  },
                  
                  // Style citation references in text - more comprehensive approach
                  text: ({ children }) => {
                    if (typeof children === 'string' && /\[\d+\]/.test(children)) {
                      const parts = children.split(/(\[\d+\])/);
                      return (
                        <>
                          {parts.map((part, index) => {
                            if (/^\[\d+\]$/.test(part)) {
                              return (
                                <span key={index} className="citation-ref">
                                  {part.slice(1, -1)}
                                </span>
                              );
                            }
                            return part;
                          })}
                        </>
                      );
                    }
                    return children;
                  },
                  
                  // Also apply to paragraph content
                  p: ({ children }) => {
                    // Process children to find and replace citation patterns
                    const processChildren = (node: any): any => {
                      if (typeof node === 'string') {
                        if (/\[\d+\]/.test(node)) {
                          const parts = node.split(/(\[\d+\])/);
                          return parts.map((part, index) => {
                            if (/^\[\d+\]$/.test(part)) {
                              return (
                                <span key={index} className="citation-ref">
                                  {part.slice(1, -1)}
                                </span>
                              );
                            }
                            return part;
                          });
                        }
                        return node;
                      }
                      if (React.isValidElement(node) && node.props.children) {
                        return React.cloneElement(node, {
                          children: React.Children.map(node.props.children, processChildren)
                        });
                      }
                      return node;
                    };
                    
                    const processedChildren = React.Children.map(children, processChildren);
                    return <p>{processedChildren}</p>;
                  },
                  
                  // Enhanced list rendering
                  ol: ({ children }) => <ol className="ordered-list">{children}</ol>,
                  ul: ({ children }) => <ul className="unordered-list">{children}</ul>,
                  li: ({ children }) => <li className="list-item">{children}</li>,
                  
                  // Enhanced headings
                  h1: ({ children }) => <h1 className="response-h1">{children}</h1>,
                  h2: ({ children }) => <h2 className="response-h2">{children}</h2>,
                  h3: ({ children }) => <h3 className="response-h3">{children}</h3>,
                  
                  // Enhanced emphasis
                  // Enhanced emphasis with citation handling
                  strong: ({ children }) => {
                    if (typeof children === 'string' && children.includes('[CITE:')) {
                      const parts = children.split(/(\[CITE:(\d+)\])/);
                      return (
                        <>
                          {parts.map((part, index) => {
                            const citeMatch = part.match(/^\[CITE:(\d+)\]$/);
                            if (citeMatch) {
                              return (
                                <span key={index} className="citation-ref">
                                  {citeMatch[1]}
                                </span>
                              );
                            }
                            return part ? <strong className="text-bold" key={index}>{part}</strong> : null;
                          })}
                        </>
                      );
                    }
                    return <strong className="text-bold">{children}</strong>;
                  },
                  em: ({ children }) => <em className="text-italic">{children}</em>,
                  
                  // Blockquotes as callouts
                  blockquote: ({ children }) => (
                    <div className="callout callout-info">
                      <div className="callout-icon">ℹ️</div>
                      <div className="callout-content">{children}</div>
                    </div>
                  ),
                  
                  // Enhanced links
                  a: ({ href, children }) => (
                    <a href={href} className="response-link" target="_blank" rel="noopener noreferrer">
                      {children} 🔗
                    </a>
                  ),
                }}
              >
                {preprocessContentForCitations(section.content)}
              </ReactMarkdown>
            </div>
          </div>
        ))}
      </div>

      {/* Citations section - only show referenced citations */}
      {referencedCitations.length > 0 && (
        <div className="citations-section">
          <h3 className="citations-header">📚 Sources</h3>
          <div className="citations-list">
            {referencedCitations.map((citation, index) => {
              // Find the original citation number from the full citations array
              const originalIndex = citations.findIndex(c => c.pageId === citation.pageId && c.url === citation.url);
              const citationNumber = originalIndex + 1;
              
              return (
                <div key={`${citation.pageId}-${index}`} className="citation-item">
                  <span className="citation-number">{citationNumber}</span>
                  <a 
                    href={citation.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="citation-link"
                    title={`Open ${citation.title} in new tab`}
                  >
                    <span className="citation-title">{citation.title}</span>
                    {citation.sectionAnchor && (
                      <span className="citation-section">#{citation.sectionAnchor}</span>
                    )}
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};