import React, { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, className = '' }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    setIsVisible(true);
  };

  const hideTooltip = () => {
    setIsVisible(false);
  };

  useEffect(() => {
    if (!isVisible || !triggerRef.current || !tooltipRef.current) return;

    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let top = triggerRect.bottom + 8;
    let left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
    
    // Adjust if tooltip would go off screen
    const padding = 16;
    if (left < padding) {
      left = padding;
    } else if (left + tooltipRect.width > window.innerWidth - padding) {
      left = window.innerWidth - tooltipRect.width - padding;
    }
    
    // If tooltip would go below viewport, show it above
    if (top + tooltipRect.height > window.innerHeight - padding) {
      top = triggerRect.top - tooltipRect.height - 8;
    }

    setPosition({ top, left });
  }, [isVisible]);

  return (
    <div
      ref={triggerRef}
      className={`tooltip-trigger ${className}`}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onFocus={showTooltip}
      onBlur={hideTooltip}
    >
      {children}
      {isVisible && content && (
        <div
          ref={tooltipRef}
          className="tooltip-content"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            zIndex: 1000,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
};