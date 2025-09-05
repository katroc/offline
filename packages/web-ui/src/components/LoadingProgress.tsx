import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';

interface LoadingProgressProps {
  query: string;
  space?: string;
  labels?: string[];
  mode?: 'rag' | 'chat';
}

const basePhases = [
  'Preparing query filters',
  'Searching documentation',
  'Ranking relevant results',
  'Extracting sections',
  'Drafting answer',
];

export const LoadingProgress: React.FC<LoadingProgressProps> = ({ query, space, labels, mode = 'rag' }) => {
  const [step, setStep] = useState(0);

  const phases = useMemo(() => {
    if (mode === 'chat') {
      return ['Starting session', 'Drafting answer'];
    }
    return [...basePhases];
  }, [mode]);

  useEffect(() => {
    setStep(0);
    const id = window.setInterval(() => {
      setStep((s) => (s < phases.length - 1 ? s + 1 : s));
    }, 1100);
    return () => window.clearInterval(id);
  }, [query, space, labels, phases]);

  return (
    <div className="loading-details" aria-live="polite">
      <div className="loading-title">
        <span>{mode === 'chat' ? 'Generating response' : 'Searching documentation and generating response'}</span>
        <span className="dots" aria-hidden>
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
      <ul className="loading-steps">
        {phases.map((label, i) => {
          const state = i < step ? 'done' : i === step ? 'active' : 'pending';
          return (
            <li key={label} className={`loading-step ${state}`}>
              <span className="step-icon" aria-hidden>
                {state === 'done' ? (
                  <Icon name="check-circle" size={14} />
                ) : state === 'active' ? (
                  <span className="spinner" />
                ) : (
                  <span className="dot" />
                )}
              </span>
              <span className="step-label">{label}</span>
            </li>
          );
        })}
      </ul>
      {mode === 'rag' && (space || (labels && labels.length > 0)) && (
        <div className="loading-context">
          {space && <span className="ctx-item">Space: {space}</span>}
          {labels && labels.length > 0 && (
            <span className="ctx-item">Labels: {labels.join(', ')}</span>
          )}
        </div>
      )}
    </div>
  );
};

export default LoadingProgress;
