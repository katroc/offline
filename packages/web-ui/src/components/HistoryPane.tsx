import React from 'react';

export interface HistoryConversation {
  id: string;
  title: string;
  updatedAt: number;
  generatingTitle?: boolean;
}

interface HistoryPaneProps {
  items: HistoryConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export const HistoryPane: React.FC<HistoryPaneProps> = ({ items, activeId, onSelect, onNew, onDelete }) => {
  const formatDate = (ts: number) => new Date(ts).toLocaleString();
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  
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
      <div className="history-list">
        {items.length === 0 ? (
          <div className="history-empty">No conversations yet</div>
        ) : (
          items.map(it => (
            <div
              key={it.id}
              className={`history-item${it.id === activeId ? ' active' : ''}${it.generatingTitle ? ' generating-title' : ''}`}
            >
              <button
                className="item-content"
                onClick={() => onSelect(it.id)}
                title={it.title}
              >
                <div className="item-title">
                  {it.title || 'Untitled'}
                  {it.generatingTitle && <span className="title-spinner" />}
                </div>
                <div className="item-date">{formatDate(it.updatedAt)}</div>
              </button>
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
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
};

export default HistoryPane;

