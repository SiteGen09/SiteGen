import type { ReactNode } from 'react';

export type IconName = 'arrow-right' | 'arrow-up-right' | 'arrow-up' | 'check' | 'play' | 'pause' | 'chat' | 'image' | 'video' | 'code' | 'sparkles' | 'plus' | 'menu' | 'close' | 'sliders' | 'wallet' | 'key' | 'chevron-down' | 'aperture' | 'waves';

const paths: Record<IconName, ReactNode> = {
  'arrow-right': <path d="M4 12h15M13 6l6 6-6 6" />,
  'arrow-up-right': <path d="M6 18 18 6M6 6h12v12" />,
  'arrow-up': <path d="M12 19V5m-6 6 6-6 6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  play: <path d="m9 5 11 7-11 7V5Z" fill="currentColor" strokeWidth="1" />,
  pause: <path d="M8 5v14M16 5v14" strokeWidth="3" />,
  chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0ZM7 10h8M7 14h5" />,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  video: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3V9Z" /></>,
  code: <><path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" /></>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  sliders: <><path d="M4 7h5m4 0h7M4 17h9m4 0h3" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  wallet: <><path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6" /><path d="M20 12h-5v5h5" /><path d="M16.5 14.5h.1" /></>,
  key: <><circle cx="8" cy="8" r="5" /><path d="m12 12 9 9m-4-4 3-3m-6 3 3-3M7 7h.01" /></>,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  aperture: <><circle cx="12" cy="12" r="9" /><path d="m10 3 6 10m4-7-6 10m7-3H9m5 8L8 11m-4 7 6-10M3 11h12" /></>,
  waves: <><path d="M3 8c3-4 5 4 8 0s5 4 10 0M3 13c3-4 5 4 8 0s5 4 10 0M3 18c3-4 5 4 8 0s5 4 10 0" /></>,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}
