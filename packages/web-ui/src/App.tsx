import React, { useState, useRef, useEffect } from 'react';
import type { RagQuery } from '@app/shared';
import { SmartResponse } from './SmartResponse';

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
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
    if (saved === 'light' || saved === 'dark') return saved;
    const prefersLight = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  });
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<Array<{id: string, object: string}>>([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Fetch available models on mount
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const response = await fetch('/models');
        if (response.ok) {
          const data = await response.json();
          setAvailableModels(data.data || []);
          // Set first model as default if none selected
          if (!selectedModel && data.data?.length > 0) {
            setSelectedModel(data.data[0].id);
          }
        }
      } catch (error) {
        console.error('Failed to fetch models:', error);
      }
    };
    fetchModels();
  }, [selectedModel]);

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
        topK: 5,
        model: selectedModel || undefined
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
      <div className="workspace">
        <header className="workspace-header">
          <div className="header-content">
            <div className="header-title">
              <h1>Claude</h1>
              <div className="model-info">
                <span className="model-badge">Documentation Assistant</span>
              </div>
            </div>
            <div className="header-actions">
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="model-selector"
                title="Select model"
              >
                {availableModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="header-button"
                title="Toggle theme"
                onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
                aria-label="Toggle theme"
              >
                {theme === 'light' ? (
                  // Moon icon
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                ) : (
                  // Sun icon
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 2v2m0 16v2m10-10h-2M4 12H2m15.364-7.364-1.414 1.414M8.05 16.95l-1.414 1.414m0-13.728L8.05 6.05m9.9 9.9 1.414 1.414"/>
                  </svg>
                )}
              </button>
              <button className="header-button" title="New conversation">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                  <polyline points="9,22 9,12 15,12 15,22"/>
                </svg>
              </button>
              <button className="header-button" title="Settings">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 1v6m0 6v6"/>
                  <path d="m21 12-6 0m-6 0-6 0"/>
                </svg>
              </button>
            </div>
          </div>
          {(space || labels) && (
            <div className="filters">
              <input
                type="text"
                placeholder="Filter by space (optional)"
                value={space}
                onChange={(e) => setSpace(e.target.value)}
                className="filter-input"
              />
              <input
                type="text"
                placeholder="Filter by labels (comma-separated)"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                className="filter-input"
              />
            </div>
          )}
        </header>

        <div className="conversation">
          {/* Empty state intentionally minimal in enterprise layout */}
          
          {messages.map((message, index) => (
            <div key={message.id} className={`message message-${message.type}`}>
              {message.type === 'user' ? (
                <div className="message-content">
                  {message.content}
                </div>
              ) : (
                <SmartResponse 
                  answer={message.content}
                  citations={message.citations || []}
                  query={index > 0 ? messages[index - 1]?.content || '' : ''}
                />
              )}
            </div>
          ))}
          
          {isLoading && (
            <div className="message message-assistant">
              <div className="message-content loading">
                Searching documentation and generating response...
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="input-area">
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
