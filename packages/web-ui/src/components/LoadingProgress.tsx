import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';

interface LoadingProgressProps {
  query: string;
  space?: string;
  labels?: string[];
  isLLMMode?: boolean;
}

const ragPhases = [
  'Initializing vector search',
  'Querying Chroma database', 
  'Ranking relevant chunks',
  'Extracting context',
  'Generating AI response',
];

const llmPhases = [
  'Processing query',
  'Generating response',
];

export const LoadingProgress: React.FC<LoadingProgressProps> = ({ query, space, labels, isLLMMode }) => {
  const [step, setStep] = useState(0);

  const phases = useMemo(() => {
    return isLLMMode ? llmPhases : ragPhases;
  }, [isLLMMode]);

  const title = useMemo(() => {
    return isLLMMode ? 'Generating response' : 'Searching documentation and generating response';
  }, [isLLMMode]);

  useEffect(() => {
    setStep(0);
    const interval = isLLMMode ? 800 : 1100; // Faster for LLM mode since fewer steps
    const id = window.setInterval(() => {
      setStep((s) => (s < phases.length - 1 ? s + 1 : s));
    }, interval);
    return () => window.clearInterval(id);
  }, [query, space, labels, phases, isLLMMode]);

  return (
    <div className="loading-details" aria-live="polite">
      <div className="loading-title">
        <span>{title}</span>
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
      {(space || (labels && labels.length > 0)) && (
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
