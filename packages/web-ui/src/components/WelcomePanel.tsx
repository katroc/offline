import React from 'react';

interface WelcomePanelProps {
  recent: string[];
  onPick: (text: string) => void;
}

export const WelcomePanel: React.FC<WelcomePanelProps> = ({ recent, onPick }) => {
  return (
    <div className="welcome-panel">
      <div className="welcome-header">Welcome to Cabin</div>
      <ul className="tips-list">
        <li>Ask a question and we’ll cite sources inline.</li>
        <li>Use filters to limit results by space or labels.</li>
        <li>Click a citation pill to jump to the source below.</li>
      </ul>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-header">Recent</div>
          <div className="recent-grid">
            {recent.slice(-6).map((q, i) => (
              <button key={i} className="recent-chip" onClick={() => onPick(q)} title={q}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default WelcomePanel;

