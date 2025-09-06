import React from 'react';

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
}

export interface HistoryConversation {
  id: string;
  title: string;
  updatedAt: number;
  generatingTitle?: boolean;
  pinned?: boolean;
  messages?: Message[];
}

interface HistoryPaneProps {
  items: HistoryConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onTogglePin: (id: string) => void;
}

export const HistoryPane: React.FC<HistoryPaneProps> = ({ items, activeId, onSelect, onNew, onDelete, onRename, onTogglePin }) => {
  const formatDate = (ts: number) => new Date(ts).toLocaleString();
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingTitle, setEditingTitle] = React.useState<string>('');
  const [searchQuery, setSearchQuery] = React.useState<string>('');
  
  // Auto-cancel after 5 seconds
  React.useEffect(() => {
    if (deletingId) {
      const timeout = setTimeout(() => {
        setDeletingId(null);
      }, 5000);
      return () => clearTimeout(timeout);
    }
  }, [deletingId]);
  
  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // Prevent selecting the item when deleting
    setDeletingId(id);
  };
  
  const confirmDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onDelete(id);
    setDeletingId(null);
  };
  
  const cancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingId(null);
  };

  const handleDoubleClick = (e: React.MouseEvent, id: string, currentTitle: string) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const handleRenameSubmit = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (editingTitle.trim()) {
      onRename(id, editingTitle.trim());
    }
    setEditingId(null);
    setEditingTitle('');
  };

  const handleRenameCancel = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setEditingId(null);
      setEditingTitle('');
    }
  };
  
  // Filter items based on search query
  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items;
    const query = searchQuery.toLowerCase();
    return items.filter(item => {
      // Search in title
      if (item.title.toLowerCase().includes(query)) {
        return true;
      }
      // Search in message content
      if (item.messages) {
        return item.messages.some(message => 
          message.content.toLowerCase().includes(query)
        );
      }
      return false;
    });
  }, [items, searchQuery]);

  return (
    <aside className="history-pane" aria-label="Conversations">
      <div className="history-header">
        <div className="history-title">Chats</div>
        <button className="history-new" title="New conversation" aria-label="New conversation" onClick={onNew}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
      </div>
      
      {items.length > 0 && (
        <div className="history-search">
          <input
            type="text"
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && (
            <button
              className="search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>
      )}
      <div className="history-list">
        {items.length === 0 ? (
          <div className="history-empty">No conversations yet</div>
        ) : filteredItems.length === 0 ? (
          <div className="history-empty">No conversations match your search</div>
        ) : (
          // Sort pinned items first, then by updatedAt
          [...filteredItems]
            .sort((a, b) => {
              if (a.pinned && !b.pinned) return -1;
              if (!a.pinned && b.pinned) return 1;
              return b.updatedAt - a.updatedAt;
            })
            .map(it => (
            <div
              key={it.id}
              className={`history-item${it.id === activeId ? ' active' : ''}${it.generatingTitle ? ' generating-title' : ''}`}
            >
              {editingId === it.id ? (
                <form onSubmit={(e) => handleRenameSubmit(e, it.id)} className="item-rename-form">
                  <input
                    type="text"
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={handleRenameCancel}
                    onBlur={() => handleRenameSubmit(new Event('submit') as any, it.id)}
                    className="item-rename-input"
                    autoFocus
                    maxLength={100}
                  />
                </form>
              ) : (
                <button
                  className="item-content"
                  onClick={() => onSelect(it.id)}
                  onDoubleClick={(e) => handleDoubleClick(e, it.id, it.title)}
                  title={it.title}
                >
                  <div className="item-title">
                    {it.title || 'Untitled'}
                    {it.generatingTitle && <span className="title-spinner" />}
                  </div>
                  <div className="item-date">{formatDate(it.updatedAt)}</div>
                </button>
              )}
              {deletingId === it.id ? (
                <div className="delete-confirm">
                  <button
                    className="confirm-delete"
                    onClick={(e) => confirmDelete(e, it.id)}
                    title="Confirm delete"
                    aria-label="Confirm delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  </button>
                  <button
                    className="cancel-delete"
                    onClick={cancelDelete}
                    title="Cancel delete"
                    aria-label="Cancel delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                  </button>
                </div>
              ) : (
                <div className="item-actions">
                  <button
                    className={`item-pin${it.pinned ? ' pinned' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(it.id);
                    }}
                    title={it.pinned ? "Unpin conversation" : "Pin conversation"}
                    aria-label={it.pinned ? "Unpin conversation" : "Pin conversation"}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 12V4a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v8l-2 2v2h12v-2l-2-2z"/>
                      <path d="M12 18v4"/>
                    </svg>
                  </button>
                  <button
                    className="item-delete"
                    onClick={(e) => handleDeleteClick(e, it.id)}
                    title="Delete conversation"
                    aria-label="Delete conversation"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6"/>
                    </svg>
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};

export default HistoryPane;

