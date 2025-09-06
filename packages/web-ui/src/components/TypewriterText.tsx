import React, { useState, useEffect } from 'react';

interface TypewriterTextProps {
  text: string;
  speed?: number; // milliseconds per character
  className?: string;
  onComplete?: () => void;
}

export const TypewriterText: React.FC<TypewriterTextProps> = ({ 
  text, 
  speed = 20, 
  className = '',
  onComplete 
}) => {
  const [displayedText, setDisplayedText] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (!text || isComplete) return;

    setDisplayedText('');
    setIsComplete(false);
    
    let currentIndex = 0;
    const interval = setInterval(() => {
      if (currentIndex >= text.length) {
        setIsComplete(true);
        onComplete?.();
        clearInterval(interval);
        return;
      }

      setDisplayedText(text.slice(0, currentIndex + 1));
      currentIndex++;
    }, speed);

    return () => clearInterval(interval);
  }, [text, speed, onComplete, isComplete]);

  return (
    <div className={className}>
      {displayedText}
      {!isComplete && <span className="typewriter-cursor">▊</span>}
    </div>
  );
};