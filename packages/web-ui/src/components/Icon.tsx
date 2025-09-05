import React from 'react';

type IconName =
  | 'book'
  | 'library'
  | 'clipboard'
  | 'info'
  | 'alert'
  | 'check-circle'
  | 'bolt'
  | 'bulb'
  | 'scale'
  | 'external-link'
  | 'tools'
  | 'stack';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 16, className, ...rest }) => {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className
  };

  switch (name) {
    case 'library':
      return (
        <svg {...common} {...rest}>
          <rect x="4" y="5" width="5" height="14" rx="1.5"/>
          <rect x="10" y="5" width="5" height="14" rx="1.5"/>
          <rect x="16" y="5" width="4" height="14" rx="1.5"/>
        </svg>
      );
    case 'book':
      return (
        <svg {...common} {...rest}>
          <path d="M6 4h10a2 2 0 0 1 2 2v12a0 0 0 0 1 0 0H8a2 2 0 0 0-2 2V6a2 2 0 0 1 2-2z"/>
          <path d="M8 4v14"/>
        </svg>
      );
    case 'clipboard':
      return (
        <svg {...common} {...rest}>
          <rect x="7" y="5" width="10" height="14" rx="2"/>
          <rect x="9" y="3" width="6" height="4" rx="1.5"/>
        </svg>
      );
    case 'info':
      return (
        <svg {...common} {...rest}>
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 10v6"/>
          <circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/>
        </svg>
      );
    case 'alert':
      return (
        <svg {...common} {...rest}>
          <path d="M12 4l8 14H4l8-14z"/>
          <path d="M12 10v4"/>
          <circle cx="12" cy="16.5" r=".8" fill="currentColor" stroke="none"/>
        </svg>
      );
    case 'check-circle':
      return (
        <svg {...common} {...rest}>
          <circle cx="12" cy="12" r="9"/>
          <path d="M8.5 12.5l2.5 2.5 4.5-5"/>
        </svg>
      );
    case 'bolt':
      return (
        <svg {...common} {...rest}>
          <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>
        </svg>
      );
    case 'bulb':
      return (
        <svg {...common} {...rest}>
          <path d="M9 18h6"/>
          <path d="M10 21h4"/>
          <path d="M8 10a4 4 0 1 1 8 0c0 2-1 3-2 4s-1 2-1 2h-2s0-1-1-2-2-2-2-4z"/>
        </svg>
      );
    case 'scale':
      return (
        <svg {...common} {...rest}>
          <path d="M12 4v3"/>
          <path d="M5 7h14"/>
          <path d="M8 7l-3 6h6l-3-6z"/>
          <path d="M16 7l-3 6h6l-3-6z"/>
          <path d="M12 10v10"/>
        </svg>
      );
    case 'external-link':
      return (
        <svg {...common} {...rest}>
          <path d="M14 4h6v6"/>
          <path d="M10 14L20 4"/>
          <path d="M20 14v6h-6"/>
          <path d="M4 10v10h10"/>
        </svg>
      );
    case 'tools':
      return (
        <svg {...common} {...rest}>
          <path d="M7 7a3 3 0 0 0 4 4l7 7a2 2 0 0 1-3 3l-7-7a3 3 0 0 0-4-4l3-3z"/>
          <path d="M14 3l3 3"/>
        </svg>
      );
    case 'stack':
      return (
        <svg {...common} {...rest}>
          <path d="M12 4l9 5-9 5-9-5 9-5z"/>
          <path d="M3 12l9 5 9-5"/>
          <path d="M3 17l9 5 9-5"/>
        </svg>
      );
    default:
      return null;
  }
};

export default Icon;
