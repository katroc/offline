import React from 'react';

interface ExamplesPanelProps {
  onPick: (text: string) => void;
}

const defaultExamples = [
  'How do I embed draw.io in Confluence? [1]'
  , 'Fix non‑Latin characters rendering issue [1]'
  , 'Which versions are affected by CVE‑2022‑1575? [1]'
  , 'How to configure space/label filters for searches'
  , 'Troubleshoot: Jira macro not rendering diagrams [1]'
  , 'Compare Simple Viewer vs Full Viewer modes'
];

export const ExamplesPanel: React.FC<ExamplesPanelProps> = ({ onPick }) => {
  return (
    <div className="examples-panel">
      <div className="examples-header">Try one of these</div>
      <div className="examples-grid">
        {defaultExamples.map((ex, i) => (
          <button key={i} className="example-chip" onClick={() => onPick(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </div>
  );
};

export default ExamplesPanel;

