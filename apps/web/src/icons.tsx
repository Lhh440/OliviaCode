import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  message: <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-5 4V6.5z" />,
  workflow: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.2 7.1l7.6 1.2M7.3 8.3l1.2 7.4M17 11.2l-6 5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18" />
    </>
  ),
  send: <path d="M5 12h13M12.5 5.5L19 12l-6.5 6.5" />,
  paperclip: <path d="M20 11.5l-8 8a4.5 4.5 0 0 1-6.4-6.4l8.2-8.2a3 3 0 1 1 4.3 4.3l-8.2 8.2a1.5 1.5 0 0 1-2.1-2.1l7.6-7.6" />,
  at: (
    <>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M15.4 8.6v4.6a3 3 0 0 0 5.4 1.7A9 9 0 1 0 17 20.4" />
    </>
  ),
  slash: <path d="M15.5 4.5l-7 15" />,
  chevron: <path d="M8 10l4 4 4-4" />,
  chevronRight: <path d="M10 8l4 4-4 4" />,
  play: <path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  ),
  download: <path d="M12 4v11M7.5 11.5L12 16l4.5-4.5M5 19.5h14" />,
  upload: <path d="M12 20V9M7.5 12.5L12 8l4.5 4.5M5 4.5h14" />,
  rotate: <path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  agent: (
    <>
      <path d="M12 3.5V6" />
      <rect x="4.5" y="6.5" width="15" height="11" rx="3" />
      <path d="M9.5 11.5v1.5M14.5 11.5v1.5M9.5 20.5v-3M14.5 20.5v-3" />
    </>
  ),
  shield: <path d="M12 3.5l7.5 2.8v5.2c0 4.6-3.2 7.6-7.5 9-4.3-1.4-7.5-4.4-7.5-9V6.3z" />,
  gate: (
    <>
      <path d="M6.5 4v16M17.5 4v16M6.5 12h11" />
      <path d="M12 9.6v4.8" />
    </>
  ),
  output: <path d="M14 4.5h5.5V10M19.5 4.5L10 14M9 5.5H5v13.5h13.5V15" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  trash: <path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 13h9l1-13" />,
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5M11 8.5v5M8.5 11h5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5M8.5 11h5" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  sparkle: <path d="M12 4l1.7 4.9L18.5 10.5l-4.8 1.6L12 17l-1.7-4.9L5.5 10.5l4.8-1.6z" />,
  folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.7l2 2h7.3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  file: <path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z M13.5 3.5V8H18" />,
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M7.5 10l2 2-2 2M12.5 14.5h4" />
    </>
  ),
  git: (
    <>
      <circle cx="7" cy="5.5" r="2.2" />
      <circle cx="7" cy="18.5" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 7.7v8.6M9.2 5.9h3.6A4.2 4.2 0 0 1 17 10v-1" />
    </>
  ),
  cpu: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M10 3.5v3M14 3.5v3M10 17.5v3M14 17.5v3M3.5 10h3M3.5 14h3M17.5 10h3M17.5 14h3" />
    </>
  ),
  dots: (
    <>
      <circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  alert: <path d="M12 4.5l8.5 15h-17zM12 10v4.5M12 17v.5" />,
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H20M17 12v3M14 12v2.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.5 2.4 2.5 13.6 0 16M12 4c-2.5 2.4-2.5 13.6 0 16" />
    </>
  ),
  layers: <path d="M12 3.5l8.5 4.5L12 12.5 3.5 8zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" />,
};

export interface IconProps {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.dots}
    </svg>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" fill="#1c1c1f" />
      <circle cx="12" cy="12" r="4.9" stroke="#fff" strokeWidth="1.9" />
      <circle cx="15.2" cy="8.8" r="1.05" fill="#fff" />
    </svg>
  );
}
