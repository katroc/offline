import React, { useState, useRef, useEffect } from 'react';
import type { RagQuery } from '@app/shared';
import { SmartResponse } from './SmartResponse';
import { LoadingProgress } from './components/LoadingProgress';

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
  // Storage keys
  const STORAGE_KEYS = {
    messages: 'chat:messages:v1',
    draft: 'chat:draft:v1',
    space: 'chat:space:v1',
    labels: 'chat:labels:v1',
    model: 'chat:model:v1',
  } as const;

  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.messages) : null;
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Message[];
      return [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.draft) || '' : ''));
  const [isLoading, setIsLoading] = useState(false);
  const [space, setSpace] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.space) || '' : ''));
  const [labels, setLabels] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.labels) || '' : ''));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
    if (saved === 'light' || saved === 'dark') return saved;
    const prefersLight = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.model) || '' : ''));
  const [availableModels, setAvailableModels] = useState<Array<{id: string, object: string}>>([]);
  const [useRag, setUseRag] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('chat:useRag:v1');
    return saved === null ? true : saved === 'true';
  });

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('chat:useRag:v1', String(useRag));
  }, [useRag]);

  // Persist state to localStorage
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      localStorage.setItem(STORAGE_KEYS.messages, JSON.stringify(messages));
    } catch {}
  }, [messages]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.draft, input);
  }, [input]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.space, space);
  }, [space]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.labels, labels);
  }, [labels]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (selectedModel) localStorage.setItem(STORAGE_KEYS.model, selectedModel);
  }, [selectedModel]);

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

  const clearConversation = () => {
    setMessages([]);
    try {
      if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEYS.messages);
    } catch {}
  };

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
      let response: Response;
      if (useRag) {
        const query: RagQuery = {
          question: input.trim(),
          space: space || undefined,
          labels: labels ? labels.split(',').map(l => l.trim()) : undefined,
          topK: 5,
          model: selectedModel || undefined
        };

        response = await fetch('/rag/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(query),
        });
      } else {
        response = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: input.trim(), model: selectedModel || undefined })
        });
      }

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
        content: result.answer && result.answer.trim().length > 0 ? result.answer : 'No response received from the model.',
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
              <h1>Cabin</h1>
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
              <button className="header-button" title="New conversation" onClick={clearConversation} aria-label="Start new conversation" disabled={messages.length === 0}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M12 5v14M5 12h14"/>
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
          {/* No welcome box; keep area clean when empty */}
          
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
                <LoadingProgress
                  query={input.trim()}
                  space={space || undefined}
                  labels={labels ? labels.split(',').map(l => l.trim()).filter(Boolean) : []}
                  mode={useRag ? 'rag' : 'chat'}
                />
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
          <label className="rag-toggle" title={useRag ? 'RAG On: answer from your docs' : 'RAG Off: general LLM'}>
            <input type="checkbox" checked={useRag} onChange={(e) => setUseRag(e.target.checked)} />
            <span className="switch" />
            <span className="rag-label">RAG</span>
          </label>
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
