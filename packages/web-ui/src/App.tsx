import React, { useState, useRef, useEffect } from 'react';
import type { RagQuery } from '@app/shared';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  citations?: Array<{
    pageId: string;
    title: string;
    url: string;
    sectionAnchor?: string;
  }>;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [space, setSpace] = useState('');
  const [labels, setLabels] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: input.trim()
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);

    try {
      const query: RagQuery = {
        question: input.trim(),
        space: space || undefined,
        labels: labels ? labels.split(',').map(l => l.trim()) : undefined,
        topK: 5
      };

      const response = await fetch('/rag/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(query),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result: { answer: string; citations: Array<{
        pageId: string;
        title: string;
        url: string;
        sectionAnchor?: string;
      }> } = await response.json();

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: result.answer,
        citations: result.citations
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setInput('');
    }
  };

  return (
    <div className="app">
      <div className="chat-container">
        <header className="chat-header">
          <h1>Air-Gapped Confluence AI</h1>
          <div className="filters">
            <input
              type="text"
              placeholder="Space (optional)"
              value={space}
              onChange={(e) => setSpace(e.target.value)}
              className="filter-input"
            />
            <input
              type="text"
              placeholder="Labels (comma-separated)"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              className="filter-input"
            />
          </div>
        </header>

        <div className="chat-messages">
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: '#666', marginTop: '2rem' }}>
              Ask a question about your Confluence content
            </div>
          )}
          
          {messages.map((message) => (
            <div key={message.id} className={`message message-${message.type}`}>
              <div className="message-bubble">
                {message.content}
              </div>
              {message.citations && message.citations.length > 0 && (
                <div className="message-citations">
                  <strong>Sources:</strong>
                  {message.citations.map((citation, index) => (
                    <a
                      key={index}
                      href={citation.url + (citation.sectionAnchor ? '#' + citation.sectionAnchor : '')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="citation"
                    >
                      {citation.title}
                      {citation.sectionAnchor && ` (${citation.sectionAnchor})`}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          
          {isLoading && (
            <div className="message message-assistant">
              <div className="message-bubble loading">
                Thinking...
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="chat-input">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question..."
            className="input-field"
            disabled={isLoading}
          />
          <button 
            type="submit" 
            className="send-button"
            disabled={!input.trim() || isLoading}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;