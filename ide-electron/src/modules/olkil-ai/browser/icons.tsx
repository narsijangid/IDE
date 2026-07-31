import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

/**
 * Inline SVG set for the agent panel chrome. Kept as components (instead of an
 * icon font) so the panel paints on the very first frame with no extra request.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function Svg({ size = 16, className, children }: React.PropsWithChildren<IconProps>) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const AiSparkIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path
      d="M12 2.6l1.62 4.36a3.4 3.4 0 0 0 2.02 2.02L20 10.6l-4.36 1.62a3.4 3.4 0 0 0-2.02 2.02L12 18.6l-1.62-4.36a3.4 3.4 0 0 0-2.02-2.02L4 10.6l4.36-1.62a3.4 3.4 0 0 0 2.02-2.02L12 2.6z"
      fill="currentColor"
    />
    <path
      d="M18.6 15.1l.62 1.68 1.68.62-1.68.62-.62 1.68-.62-1.68-1.68-.62 1.68-.62.62-1.68z"
      fill="currentColor"
      opacity="0.75"
    />
  </Svg>
);

export const SendIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M12 19V5.6" {...stroke} />
    <path d="M6.2 11.4L12 5.6l5.8 5.8" {...stroke} />
  </Svg>
);

export const StopIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <rect x="7" y="7" width="10" height="10" rx="2.4" fill="currentColor" />
  </Svg>
);

export const CheckIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M5 12.8l4.4 4.4L19 7.6" {...stroke} />
  </Svg>
);

export const MinimizeIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M6 12.5h12" {...stroke} />
  </Svg>
);

export const CloseIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4" {...stroke} />
  </Svg>
);

export const ExpandIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M14 4.6h5.4V10" {...stroke} />
    <path d="M10 19.4H4.6V14" {...stroke} />
    <path d="M19.4 4.6l-6.6 6.6M4.6 19.4l6.6-6.6" {...stroke} />
  </Svg>
);

export const CollapseIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M19.4 10H14V4.6" {...stroke} />
    <path d="M4.6 14H10v5.4" {...stroke} />
    <path d="M14 10l5.4-5.4M10 14l-5.4 5.4" {...stroke} />
  </Svg>
);

export const NewChatIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <path d="M12 6v12M6 12h12" {...stroke} />
  </Svg>
);

export const PinIcon = ({ size, className }: IconProps) => (
  <Svg size={size} className={className}>
    <circle cx="12" cy="8.2" r="3.4" {...stroke} />
    <path d="M12 11.6V20" {...stroke} />
  </Svg>
);
