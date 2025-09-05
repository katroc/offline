import React from 'react';

export interface HistoryConversation {
  id: string;
  title: string;
  updatedAt: number;
}

interface HistoryPaneProps {
  items: HistoryConversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export const HistoryPane: React.FC<HistoryPaneProps> = ({ items, activeId, onSelect, onNew }) => {
  const formatDate = (ts: number) => new Date(ts).toLocaleString();
  return (
    <aside className="history-pane" aria-label="Conversations">
      <div className="history-header">
        <div className="history-title">History</div>
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
            <button
              key={it.id}
              className={`history-item${it.id === activeId ? ' active' : ''}`}
              onClick={() => onSelect(it.id)}
              title={it.title}
            >
              <div className="item-title">{it.title || 'Untitled'}</div>
              <div className="item-date">{formatDate(it.updatedAt)}</div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
};

export default HistoryPane;

