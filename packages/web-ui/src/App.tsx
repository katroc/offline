import React, { useState, useRef, useEffect } from 'react';
import type { RagQuery } from '@app/shared';
import { SmartResponse } from './SmartResponse';
import { LoadingProgress } from './components/LoadingProgress';
import { HistoryPane, type HistoryConversation } from './components/HistoryPane';
import { generateConversationTitle, shouldUpdateTitle } from './utils/titleSummarization';

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

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  generatingTitle?: boolean;
}

function App() {
  // Storage keys
  const STORAGE_KEYS = {
    conversations: 'chat:conversations:v1',
    activeId: 'chat:activeId:v1',
    draft: 'chat:draft:v1',
    space: 'chat:space:v1',
    labels: 'chat:labels:v1',
    model: 'chat:model:v1',
    legacyMessages: 'chat:messages:v1',
  } as const;

  // Load conversations (migrate from legacy single-thread messages if present)
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    try {
      if (typeof window === 'undefined') return [];
      const raw = localStorage.getItem(STORAGE_KEYS.conversations);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as Conversation[];
      }
      // Migration: check old messages key
      const legacy = localStorage.getItem(STORAGE_KEYS.legacyMessages);
      if (legacy) {
        const msgs = JSON.parse(legacy) as Message[];
        const now = Date.now();
        const conv: Conversation = {
          id: String(now),
          title: msgs.find(m => m.type === 'user')?.content?.slice(0, 60) || 'Conversation',
          createdAt: now,
          updatedAt: now,
          messages: msgs,
        };
        return [conv];
      }
      return [];
    } catch {
      return [];
    }
  });
  const [activeId, setActiveId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEYS.activeId) || (null as string | null);
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversations, activeId]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  

  // Persist conversations and active selection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEYS.conversations, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (activeId) localStorage.setItem(STORAGE_KEYS.activeId, activeId);
  }, [activeId]);

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

  const createConversation = () => {
    const now = Date.now();
    const conv: Conversation = { id: String(now), title: 'New conversation', createdAt: now, updatedAt: now, messages: [] };
    setConversations(prev => [conv, ...prev]);
    setActiveId(conv.id);
  };

  const deleteConversation = (id: string) => {
    setConversations(prev => prev.filter(c => c.id !== id));
    // If we're deleting the active conversation, switch to the next one
    if (activeId === id) {
      const remaining = conversations.filter(c => c.id !== id);
      setActiveId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const current = conversations.find(c => c.id === activeId) || conversations[0];
  useEffect(() => {
    if (!activeId && conversations.length > 0) setActiveId(conversations[0].id);
  }, [activeId, conversations.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      type: 'user',
      content: input.trim()
    };
    if (!current) {
      createConversation();
    }
    setConversations(prev => {
      const list = [...prev];
      const idx = list.findIndex(c => c.id === (current?.id || activeId));
      const targetIdx = idx >= 0 ? idx : 0;
      const conv = { ...(list[targetIdx] || { id: String(Date.now()), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }) } as Conversation;
      conv.messages = [...conv.messages, userMessage];
      if (!conv.title || conv.title === 'New conversation') {
        conv.title = userMessage.content.slice(0, 60);
      }
      conv.updatedAt = Date.now();
      list[targetIdx] = conv;
      return list;
    });
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

      setConversations(prev => {
        const list = [...prev];
        const idx = list.findIndex(c => c.id === (current?.id || activeId));
        const targetIdx = idx >= 0 ? idx : 0;
        const conv = { ...list[targetIdx] } as Conversation;
        conv.messages = [...conv.messages, assistantMessage];
        conv.updatedAt = Date.now();
        list[targetIdx] = conv;
        
        // Auto-generate title if appropriate
        const firstUserMsg = conv.messages.find(m => m.type === 'user')?.content;
        
        if (shouldUpdateTitle(conv.title, conv.messages.length, firstUserMsg)) {
          // Set loading state
          setConversations(currentList => {
            const updatedList = [...currentList];
            const convIdx = updatedList.findIndex(c => c.id === conv.id);
            if (convIdx >= 0) {
              updatedList[convIdx] = { ...updatedList[convIdx], generatingTitle: true };
            }
            return updatedList;
          });
          
          generateConversationTitle(conv.messages, selectedModel)
            .then(newTitle => {
              setConversations(currentList => {
                const updatedList = [...currentList];
                const convIdx = updatedList.findIndex(c => c.id === conv.id);
                if (convIdx >= 0) {
                  updatedList[convIdx] = { ...updatedList[convIdx], title: newTitle, generatingTitle: false };
                }
                return updatedList;
              });
            })
            .catch(error => {
              console.warn('Failed to update conversation title:', error);
              setConversations(currentList => {
                const updatedList = [...currentList];
                const convIdx = updatedList.findIndex(c => c.id === conv.id);
                if (convIdx >= 0) {
                  updatedList[convIdx] = { ...updatedList[convIdx], generatingTitle: false };
                }
                return updatedList;
              });
            });
        }
        
        return list;
      });
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        type: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
      };
      setConversations(prev => {
        const list = [...prev];
        const idx = list.findIndex(c => c.id === (current?.id || activeId));
        const targetIdx = idx >= 0 ? idx : 0;
        const conv = { ...(list[targetIdx] || { id: String(Date.now()), title: 'New conversation', createdAt: Date.now(), updatedAt: Date.now(), messages: [] }) } as Conversation;
        conv.messages = [...(conv.messages || []), errorMessage];
        conv.updatedAt = Date.now();
        list[targetIdx] = conv;
        return list;
      });
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
              {/* New conversation button moved to HistoryPane header */}
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

        <div className="workarea">
          <HistoryPane
            items={conversations.map<HistoryConversation>(c => ({ 
              id: c.id, 
              title: c.title || 'Untitled', 
              updatedAt: c.updatedAt,
              generatingTitle: c.generatingTitle
            }))}
            activeId={current?.id || null}
            onSelect={(id) => setActiveId(id)}
            onNew={createConversation}
            onDelete={deleteConversation}
          />
          <div className="main-pane">
            <div className="conversation">
              {/* No welcome box; keep area clean when empty */}
              
          {(current?.messages || []).map((message, index) => (
            <div key={message.id} className={`message message-${message.type}`}>
              {message.type === 'user' ? (
                <div className="message-content">
                  {message.content}
                </div>
              ) : (
                <SmartResponse 
                  answer={message.content}
                  citations={message.citations || []}
                  query={index > 0 ? (current?.messages[index - 1]?.content || '') : ''}
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
      </div>
    </div>
  );
}

export default App;
