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
    snippet?: string;
  }>;
  displayCitations?: Array<{
    pageId: string;
    title: string;
    url: string;
    sectionAnchor?: string;
    snippet?: string;
  }>;
  citationIndexMap?: number[]; // original index -> display index
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  generatingTitle?: boolean;
  pinned?: boolean;
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
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [animatingMessageId, setAnimatingMessageId] = useState<string | null>(null);
  const [space, setSpace] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.space) || '' : ''));
  const [labels, setLabels] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.labels) || '' : ''));
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
    if (saved === 'light' || saved === 'dark') return saved;
    const prefersLight = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  });
  const [selectedModel, setSelectedModel] = useState<string>(() => (typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.model) || '' : ''));
  const [availableModels, setAvailableModels] = useState<Array<{id: string, object: string}>>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
  const exportDropdownRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deleteAllInput, setDeleteAllInput] = useState('');
  const deleteAllInputRef = useRef<HTMLInputElement>(null);
  const canConfirmDeleteAll = (deleteAllInput || '').trim().toUpperCase() === 'DELETE';
  const confirmDeleteAll = () => {
    if (!canConfirmDeleteAll) return;
    deleteAllConversations();
    setDeleteAllOpen(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };
  const [topK, setTopK] = useState(() => (typeof window !== 'undefined' ? Number(localStorage.getItem('settings:topK')) || 5 : 5));
  const [temperature, setTemperature] = useState(() => (typeof window !== 'undefined' ? Number(localStorage.getItem('settings:temperature')) || 0.7 : 0.7));
  const [ragBypass, setRagBypass] = useState(() => (typeof window !== 'undefined' ? localStorage.getItem('settings:ragBypass') === 'true' : false));
  // Crawler config state (admin)
  const [crawlerAllSpaces, setCrawlerAllSpaces] = useState(true);
  const [crawlerSpaces, setCrawlerSpaces] = useState('');
  const [crawlerPageSize, setCrawlerPageSize] = useState(50);
  const [crawlerMaxPages, setCrawlerMaxPages] = useState(200);
  const [crawlerConcurrency, setCrawlerConcurrency] = useState(4);
  const [availableSpaces, setAvailableSpaces] = useState<string[]>([]);
  const [notification, setNotification] = useState<{message: string, type: 'success' | 'error' | 'info'} | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const showNotification = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000); // Auto-hide after 3 seconds
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversations, activeId]);

  // Clear animation state after animation completes
  useEffect(() => {
    if (animatingMessageId) {
      // Clear animation after a delay longer than the animation duration
      const timeout = setTimeout(() => {
        setAnimatingMessageId(null);
      }, 5000); // Generous timeout for long messages
      
      return () => clearTimeout(timeout);
    }
  }, [animatingMessageId]);

  // Close export dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportDropdownRef.current && !exportDropdownRef.current.contains(event.target as Node)) {
        setExportDropdownOpen(false);
      }
    };

    if (exportDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [exportDropdownOpen]);

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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('settings:topK', String(topK));
  }, [topK]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('settings:temperature', String(temperature));
  }, [temperature]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('settings:ragBypass', String(ragBypass));
  }, [ragBypass]);


  // Load crawler config when settings drawer opens
  useEffect(() => {
    if (!settingsOpen) return;
    (async () => {
      try {
        const res = await fetch('/admin/crawler/config');
        if (res.ok) {
          const cfg = await res.json();
          setCrawlerAllSpaces(!!cfg.allSpaces);
          setCrawlerSpaces(Array.isArray(cfg.spaces) ? cfg.spaces.join(',') : '');
          setCrawlerPageSize(Number(cfg.pageSize || 50));
          setCrawlerMaxPages(Number(cfg.maxPagesPerTick || 200));
          setCrawlerConcurrency(Number(cfg.concurrency || 4));
        }
      } catch {}
    })();
  }, [settingsOpen]);

  const refreshSpaces = async () => {
    try {
      const res = await fetch('/admin/confluence/spaces');
      if (res.ok) {
        const data = await res.json();
        setAvailableSpaces(Array.isArray(data.spaces) ? data.spaces : []);
      }
    } catch {}
  };

  const saveCrawlerConfig = async () => {
    try {
      const body = {
        allSpaces: crawlerAllSpaces,
        spaces: crawlerAllSpaces ? [] : crawlerSpaces.split(',').map(s => s.trim()).filter(Boolean),
        pageSize: crawlerPageSize,
        maxPagesPerTick: crawlerMaxPages,
        concurrency: crawlerConcurrency
      };
      const res = await fetch('/admin/crawler/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        showNotification('Crawler configuration saved successfully!', 'success');
      } else {
        showNotification('Failed to save crawler configuration', 'error');
      }
    } catch (error) {
      showNotification('Error saving crawler configuration', 'error');
    }
  };

  const triggerSync = async () => {
    try {
      const body: any = {};
      if (!crawlerAllSpaces) {
        body.spaces = crawlerSpaces.split(',').map((s: string) => s.trim()).filter(Boolean);
      }
      body.pageSize = crawlerPageSize;
      body.maxPages = crawlerMaxPages;
      const res = await fetch('/admin/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        showNotification('Sync started successfully! This may take a few moments to complete.', 'info');
      } else {
        showNotification('Failed to start sync', 'error');
      }
    } catch (error) {
      showNotification('Error starting sync', 'error');
    }
  };

  // Check server health and connection status
  const checkHealth = async () => {
    try {
      const response = await fetch('/health', { cache: 'no-cache' });
      if (response.ok) {
        setIsOnline(true);
        setConnectionError(null);
        return true;
      } else {
        setIsOnline(false);
        setConnectionError(`Server error: ${response.status}`);
        return false;
      }
    } catch (error) {
      setIsOnline(false);
      setConnectionError(error instanceof Error ? error.message : 'Connection failed');
      return false;
    }
  };

  // Fetch available models on mount and periodically check health
  useEffect(() => {
    const fetchModels = async () => {
      const isHealthy = await checkHealth();
      if (!isHealthy) return;

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

    // Check health every 30 seconds
    const healthInterval = setInterval(checkHealth, 30000);
    return () => clearInterval(healthInterval);
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

  const deleteAllConversations = () => {
    setConversations([]);
    setActiveId(null);
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(STORAGE_KEYS.conversations);
        localStorage.removeItem(STORAGE_KEYS.activeId);
      }
    } catch {
      // ignore storage errors
    }
  };

  const openDeleteAllModal = () => {
    setDeleteAllInput('');
    setDeleteAllOpen(true);
    // Slight delay to ensure element exists before focusing
    setTimeout(() => deleteAllInputRef.current?.focus(), 50);
  };

  const renameConversation = (id: string, newTitle: string) => {
    setConversations(prev => prev.map(c => 
      c.id === id ? { ...c, title: newTitle, updatedAt: Date.now() } : c
    ));
  };

  const togglePinConversation = (id: string) => {
    setConversations(prev => prev.map(c => 
      c.id === id ? { ...c, pinned: !c.pinned, updatedAt: Date.now() } : c
    ));
  };

  const exportConversation = (format: 'markdown' | 'json') => {
    if (!current) return;

    const timestamp = new Date(current.updatedAt).toLocaleString();
    let content: string;
    let filename: string;
    let mimeType: string;

    // Helper: compute only the citations that were actually referenced in the answer text
    const getReferencedCitations = (
      message: Message
    ): Array<{ pageId: string; title: string; url: string; sectionAnchor?: string; snippet?: string }> => {
      const text = message.content || '';
      const all = message.citations || [];
      const display = message.displayCitations || [];
      const map = message.citationIndexMap || [];
      const numsInOrder: number[] = [];
      const seen = new Set<number>();
      const re = /\[(\d+)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && n > 0 && !seen.has(n)) {
          seen.add(n);
          numsInOrder.push(n);
        }
      }
      const uniqueBy = new Set<string>();
      const picked: typeof all = [];
      for (const n of numsInOrder) {
        const idx0 = n - 1;
        let cit = all[idx0];
        if (display.length > 0 && map.length > idx0 && typeof map[idx0] === 'number') {
          const dispIdx = map[idx0] as number;
          cit = display[dispIdx] || cit;
        }
        if (cit) {
          const key = `${cit.pageId}|${cit.url}`;
          if (!uniqueBy.has(key)) {
            uniqueBy.add(key);
            picked.push(cit);
          }
        }
      }
      return picked;
    };

    if (format === 'markdown') {
      content = `# ${current.title}\n\n*Exported: ${timestamp}*\n\n`;
      
      current.messages.forEach(msg => {
        if (msg.type === 'user') {
          content += `## User\n\n${msg.content}\n\n`;
        } else {
          content += `## Assistant\n\n${msg.content}\n\n`;
          const referenced = getReferencedCitations(msg);
          if (referenced.length > 0) {
            content += `### Sources\n\n`;
            referenced.forEach((citation, idx) => {
              content += `${idx + 1}. [${citation.title}](${citation.url})\n`;
            });
            content += '\n';
          }
        }
      });

      filename = `${current.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}.md`;
      mimeType = 'text/markdown';
    } else {
      content = JSON.stringify({
        id: current.id,
        title: current.title,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        exportedAt: Date.now(),
        messages: current.messages.map(msg => {
          if (msg.type === 'assistant') {
            return {
              id: msg.id,
              type: msg.type,
              content: msg.content,
              citations: getReferencedCitations(msg)
            };
          }
          return {
            id: msg.id,
            type: msg.type,
            content: msg.content,
            citations: [] as any[]
          };
        })
      }, null, 2);

      filename = `${current.title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')}.json`;
      mimeType = 'application/json';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const current = conversations.find(c => c.id === activeId) || conversations[0];
  useEffect(() => {
    if (!activeId && conversations.length > 0) setActiveId(conversations[0].id);
  }, [activeId, conversations.length]);

  // Focus input when switching conversations
  useEffect(() => {
    if (activeId) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [activeId]);

  const stopGeneration = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const controller = new AbortController();
    setAbortController(controller);

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

    const assistantMessageId = (Date.now() + 1).toString();

    try {
      const query: RagQuery = {
        question: input.trim(),
        space: space || undefined,
        labels: labels ? labels.split(',').map(l => l.trim()) : undefined,
        topK: topK,
        model: selectedModel || undefined,
        conversationId: (current?.id || activeId) || undefined,
        ragBypass: ragBypass || undefined,
      };

      const response = await fetch('/rag/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(query),
        signal: controller.signal
      });

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorData = await response.json();
          if (errorData.error) {
            errorMessage = errorData.error;
          }
        } catch {
          // Fall back to status text if JSON parsing fails
          errorMessage = response.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const result: { answer: string; citations: Array<{
        pageId: string;
        title: string;
        url: string;
        sectionAnchor?: string;
        snippet?: string;
      }>; displayCitations?: Array<{
        pageId: string;
        title: string;
        url: string;
        sectionAnchor?: string;
        snippet?: string;
      }>; citationIndexMap?: number[] } = await response.json();

      const assistantMessage: Message = {
        id: assistantMessageId,
        type: 'assistant',
        content: result.answer,
        citations: result.citations,
        displayCitations: result.displayCitations,
        citationIndexMap: result.citationIndexMap
      };

      setConversations(prev => {
        const list = [...prev];
        const idx = list.findIndex(c => c.id === (current?.id || activeId));
        const targetIdx = idx >= 0 ? idx : 0;
        const conv = { ...list[targetIdx] } as Conversation;
        conv.messages = [...conv.messages, assistantMessage];
        conv.updatedAt = Date.now();
        list[targetIdx] = conv;
        return list;
      });

      // Trigger animation for the new message
      setAnimatingMessageId(assistantMessageId);

      // Title generation after streaming completes
      setConversations(prev => {
        const list = [...prev];
        const idx = list.findIndex(c => c.id === (current?.id || activeId));
        const targetIdx = idx >= 0 ? idx : 0;
        const conv = { ...list[targetIdx] } as Conversation;
        
        const firstUserMsg = conv.messages.find(m => m.type === 'user')?.content;
        
        if (shouldUpdateTitle(conv.title, conv.messages.length, firstUserMsg)) {
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
      if (error instanceof Error && error.name === 'AbortError') {
        // Request was aborted
        return;
      }
      
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
      setAbortController(null);
      setIsLoading(false);
      setInput('');
      // Re-focus the input after submitting
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  };

  return (
    <div className="app">
      <div className="workspace">
        <header className="workspace-header">
          <div className="header-content">
            <div className="header-title">
              <h1>Cabin</h1>
              {!isOnline && (
                <div className="connection-status offline" title={`Offline: ${connectionError}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 14V2"/>
                    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.53l2.5-8A2 2 0 0 1 6.66 2H17"/>
                    <path d="M13 8h8"/>
                  </svg>
                  <span>Offline</span>
                </div>
              )}
            </div>
            <div className="header-actions">
              <button
                type="button"
                className="header-button"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
                aria-label="Open settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.07a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
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
              {current && current.messages.length > 0 && (
                <div className="export-dropdown" ref={exportDropdownRef}>
                  <button
                    className="header-button"
                    onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
                    title="Export conversation"
                    aria-label="Export conversation"
                    aria-expanded={exportDropdownOpen}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7,10 12,15 17,10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ marginLeft: '4px' }}>
                      <polyline points="6,9 12,15 18,9"/>
                    </svg>
                  </button>
                  {exportDropdownOpen && (
                    <div className="export-dropdown-menu">
                      <button
                        className="export-option"
                        onClick={() => {
                          exportConversation('markdown');
                          setExportDropdownOpen(false);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14,2 14,8 20,8"/>
                        </svg>
                        Export as Markdown
                      </button>
                      <button
                        className="export-option"
                        onClick={() => {
                          exportConversation('json');
                          setExportDropdownOpen(false);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14,2 14,8 20,8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                          <polyline points="10,9 9,9 8,9"/>
                        </svg>
                        Export as JSON
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* New conversation button moved to HistoryPane header */}
            </div>
          </div>
        </header>

        <div className="workarea">
          <HistoryPane
            items={conversations.map<HistoryConversation>(c => ({ 
              id: c.id, 
              title: c.title || 'Untitled', 
              updatedAt: c.updatedAt,
              generatingTitle: c.generatingTitle,
              pinned: c.pinned,
              messages: c.messages
            }))}
            activeId={current?.id || null}
            onSelect={(id) => setActiveId(id)}
            onNew={createConversation}
            onDelete={deleteConversation}
            onRename={renameConversation}
            onTogglePin={togglePinConversation}
            onDeleteAll={deleteAllConversations}
            onDeleteAllRequest={openDeleteAllModal}
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
                  displayCitations={message.displayCitations}
                  citationIndexMap={message.citationIndexMap}
                  query={index > 0 ? (current?.messages[index - 1]?.content || '') : ''}
                  animate={animatingMessageId === message.id}
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
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={!isOnline ? "Offline - check connection..." : "Ask a question..."}
            className="input-field"
            disabled={isLoading || !isOnline}
            autoFocus
          />
          {isLoading ? (
            <button 
              type="button" 
              className="stop-button"
              onClick={stopGeneration}
            >
              Stop
            </button>
          ) : (
            <button 
              type="submit" 
              className="send-button"
              disabled={!input.trim() || !isOnline}
              title={!isOnline ? "Cannot send while offline" : undefined}
            >
              Send
            </button>
          )}
            </form>
          </div>
        </div>
      </div>

      {/* Settings Drawer */}
      {settingsOpen && (
        <div className="settings-overlay" onClick={() => {
          setSettingsOpen(false);
          setTimeout(() => inputRef.current?.focus(), 100);
        }}>
          <div className="settings-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Settings</h2>
              <button
                className="settings-close"
                onClick={() => {
                  setSettingsOpen(false);
                  setTimeout(() => inputRef.current?.focus(), 100);
                }}
                aria-label="Close settings"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            
            <div className="settings-content">
              {/* Query Settings - Most relevant for users */}
              <div className="settings-section">
                <h3>Query Settings</h3>
                <div className="setting-group">
                  <label htmlFor="space-setting">
                    <span>Space filter</span>
                    <span className="setting-description">Limit search to specific Confluence space</span>
                  </label>
                  <input
                    id="space-setting"
                    type="text"
                    placeholder="e.g., DOCS, TECH, PROD"
                    value={space}
                    onChange={(e) => setSpace(e.target.value)}
                    className="text-input"
                    disabled={ragBypass}
                  />
                </div>

                <div className="setting-group">
                  <label htmlFor="labels-setting">
                    <span>Labels filter</span>
                    <span className="setting-description">Comma-separated labels to filter by</span>
                  </label>
                  <input
                    id="labels-setting"
                    type="text"
                    placeholder="e.g., api, guide, tutorial"
                    value={labels}
                    onChange={(e) => setLabels(e.target.value)}
                    className="text-input"
                    disabled={ragBypass}
                  />
                </div>

                <div className="setting-group">
                  <label htmlFor="topK-setting">
                    <span>Documents to retrieve</span>
                    <span className="setting-description">Number of relevant documents to find for each query</span>
                  </label>
                  <div className="range-input-group">
                    <input
                      id="topK-setting"
                      type="range"
                      min="1"
                      max="20"
                      value={topK}
                      onChange={(e) => setTopK(Number(e.target.value))}
                      className="range-input"
                      disabled={ragBypass}
                    />
                    <span className="range-value">{topK}</span>
                  </div>
                </div>

                <div className="setting-group checkbox-group">
                  <label htmlFor="rag-bypass-setting">
                    <span>RAG Bypass Mode</span>
                    <span className="setting-description">Skip document retrieval and answer directly using AI knowledge</span>
                  </label>
                  <input
                    id="rag-bypass-setting"
                    type="checkbox"
                    checked={ragBypass}
                    onChange={(e) => setRagBypass(e.target.checked)}
                  />
                </div>

              </div>

              {/* Model Settings */}
              <div className="settings-section">
                <h3>Model Settings</h3>
                <div className="setting-group">
                  <label htmlFor="model-setting">
                    <span>Language Model</span>
                    <span className="setting-description">Choose the AI model for generating responses</span>
                  </label>
                  <select
                    id="model-setting"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="select-input"
                  >
                    {availableModels.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="setting-group">
                  <label htmlFor="temperature-setting">
                    <span>Temperature</span>
                    <span className="setting-description">Controls creativity vs consistency (0.0 = focused, 1.0 = creative)</span>
                  </label>
                  <div className="range-input-group">
                    <input
                      id="temperature-setting"
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={temperature}
                      onChange={(e) => setTemperature(Number(e.target.value))}
                      className="range-input"
                    />
                    <span className="range-value">{temperature.toFixed(1)}</span>
                  </div>
                </div>
              </div>

              {/* Crawler Settings - Data indexing configuration */}
              <div className="settings-section">
                <h3>Crawler Settings</h3>
                <div className="setting-group checkbox-group">
                  <label htmlFor="crawler-allspaces">
                    <span>Crawl all spaces</span>
                    <span className="setting-description">Index all available Confluence spaces</span>
                  </label>
                  <input
                    id="crawler-allspaces"
                    type="checkbox"
                    checked={crawlerAllSpaces}
                    onChange={(e) => setCrawlerAllSpaces(e.target.checked)}
                  />
                </div>
                <div className="setting-group">
                  <label htmlFor="crawler-spaces">
                    <span>Specific spaces to crawl</span>
                    <span className="setting-description">Comma-separated list of space keys (only when not crawling all)</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="crawler-spaces"
                      type="text"
                      placeholder="e.g., ENG,OPS,DOCS"
                      value={crawlerSpaces}
                      onChange={(e) => setCrawlerSpaces(e.target.value)}
                      className="text-input"
                      disabled={crawlerAllSpaces}
                    />
                    <button className="header-button" type="button" onClick={refreshSpaces} title="Fetch available spaces" aria-label="Fetch available spaces">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10M1 14l5.36 4.36A9 9 0 0 0 20.49 15"/>
                      </svg>
                    </button>
                  </div>
                  {availableSpaces.length > 0 && (
                    <div className="setting-description">Available spaces: {availableSpaces.join(', ')}</div>
                  )}
                </div>
                <div className="setting-group">
                  <label htmlFor="crawler-pagesize">
                    <span>Batch size</span>
                    <span className="setting-description">Number of pages to fetch per API request (1-100)</span>
                  </label>
                  <input
                    id="crawler-pagesize"
                    type="number"
                    min={1}
                    max={100}
                    value={crawlerPageSize}
                    onChange={(e) => setCrawlerPageSize(Number(e.target.value))}
                    className="text-input"
                  />
                </div>
                <div className="setting-group">
                  <label htmlFor="crawler-maxpages">
                    <span>Max pages per sync</span>
                    <span className="setting-description">Maximum number of pages to process in a single sync operation</span>
                  </label>
                  <input
                    id="crawler-maxpages"
                    type="number"
                    min={1}
                    value={crawlerMaxPages}
                    onChange={(e) => setCrawlerMaxPages(Number(e.target.value))}
                    className="text-input"
                  />
                </div>
                <div className="setting-group">
                  <label htmlFor="crawler-concurrency">
                    <span>Processing threads</span>
                    <span className="setting-description">Number of pages to process simultaneously (1-64)</span>
                  </label>
                  <input
                    id="crawler-concurrency"
                    type="number"
                    min={1}
                    max={64}
                    value={crawlerConcurrency}
                    onChange={(e) => setCrawlerConcurrency(Number(e.target.value))}
                    className="text-input"
                  />
                </div>
                <div className="settings-action-buttons">
                  <button className="settings-action-button" type="button" onClick={saveCrawlerConfig} title="Save crawler config" aria-label="Save crawler config">
                    Save
                  </button>
                  <button className="settings-action-button secondary" type="button" onClick={triggerSync} title="Sync now" aria-label="Sync now">
                    Sync Now
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notification Toast */}
      {notification && (
        <div className={`notification-toast ${notification.type}`}>
          {notification.type === 'success' && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
          )}
          {notification.type === 'error' && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          )}
          {notification.type === 'info' && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4m0-4h.01"/>
            </svg>
          )}
          {notification.message}
        </div>
      )}

      {/* Delete All Confirmation Modal */}
      {deleteAllOpen && (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-delete-all-title" onClick={() => {
          setDeleteAllOpen(false);
          setTimeout(() => inputRef.current?.focus(), 100);
        }}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()} aria-describedby="confirm-delete-all-desc">
            <div className="confirm-header">
              <div className="confirm-title">
                <svg className="confirm-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M12 9v4m0 4h.01M10.29 3.86l-7.5 12.99A1 1 0 0 0 3.65 19h16.7a1 1 0 0 0 .86-1.15l-3.1-13A1 1 0 0 0 17.16 4H6.84a1 1 0 0 0-.55.16z"/>
                </svg>
                <h2 id="confirm-delete-all-title">Delete All Chats</h2>
              </div>
              <button
                className="confirm-close"
                onClick={() => {
                  setDeleteAllOpen(false);
                  setTimeout(() => inputRef.current?.focus(), 100);
                }}
                aria-label="Close"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="confirm-body">
              <div className="confirm-warning" role="alert" id="confirm-delete-all-desc">
                <strong>Warning:</strong> This will permanently remove all {conversations.length} chat{conversations.length === 1 ? '' : 's'} stored in this browser. This cannot be undone.
              </div>
              <div className="confirm-instruction">
                <label htmlFor="confirm-delete-input">
                  To confirm, type <span className="confirm-token">DELETE</span> below.
                </label>
                <input
                  id="confirm-delete-input"
                  ref={deleteAllInputRef}
                  type="text"
                  value={deleteAllInput}
                  onChange={(e) => setDeleteAllInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      confirmDeleteAll();
                    } else if (e.key === 'Escape') {
                      setDeleteAllOpen(false);
                      setTimeout(() => inputRef.current?.focus(), 100);
                    }
                  }}
                  aria-invalid={deleteAllInput.length > 0 && !canConfirmDeleteAll}
                  className="confirm-input"
                  placeholder="DELETE"
                />
                <div className="confirm-hint">Only chats on this device will be deleted.</div>
              </div>
            </div>
            <div className="confirm-actions">
              <button
                className="button ghost"
                onClick={() => {
                  setDeleteAllOpen(false);
                  setTimeout(() => inputRef.current?.focus(), 100);
                }}
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={!canConfirmDeleteAll}
                onClick={confirmDeleteAll}
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
