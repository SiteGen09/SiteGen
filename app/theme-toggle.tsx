'use client';

import { useSyncExternalStore } from 'react';
import { THEME_CHOICES, THEME_STORAGE_KEY, isThemeChoice, type ThemeChoice } from '@/lib/theme';

const LABELS: Record<ThemeChoice, string> = {
  light: 'Light',
  system: 'System',
  dark: 'Dark',
};

/**
 * The stored preference is an external store, so the control subscribes to it
 * rather than mirroring it into state: that keeps a second tab (or a second
 * copy of this switch on the same page) in step, and leaves the server render
 * free to fall back to "system".
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function serverChoice(): ThemeChoice {
  return 'system';
}

/** Applies the choice the same way the pre-paint script does. */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
  try {
    if (choice === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Storage is unavailable (private mode, blocked cookies). The attribute is
    // still set, so the switch works for this page view and simply forgets.
  }
  // `storage` only fires in *other* tabs, so nudge this one by hand.
  for (const listener of listeners) listener();
}

function Icon({ choice }: { choice: ThemeChoice }) {
  const common = {
    'aria-hidden': true,
    viewBox: '0 0 20 20',
    className: 'h-3.5 w-3.5',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (choice === 'light') {
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="3.4" />
        <path d="M10 2.4v1.7M10 15.9v1.7M2.4 10h1.7M15.9 10h1.7M4.6 4.6l1.2 1.2M14.2 14.2l1.2 1.2M15.4 4.6l-1.2 1.2M5.8 14.2l-1.2 1.2" />
      </svg>
    );
  }
  if (choice === 'dark') {
    return (
      <svg {...common}>
        <path d="M16 11.7A6.6 6.6 0 0 1 8.3 4a6.6 6.6 0 1 0 7.7 7.7Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2.6" y="3.8" width="14.8" height="10" rx="1.6" />
      <path d="M7.5 16.6h5M10 13.8v2.8" />
    </svg>
  );
}

/**
 * Three-way theme switch. The stored choice is only readable on the client, so
 * the server renders "System" selected and the real choice lands on hydration.
 */
export function ThemeToggle({
  className,
  labels = false,
}: {
  className?: string;
  /** Off by default: the sidebar and mobile panel only have room for icons. */
  labels?: boolean;
}) {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={`inline-flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-zinc-50 p-0.5 ${className ?? ''}`.trimEnd()}
    >
      {THEME_CHOICES.map((item) => {
        const selected = choice === item;
        return (
          <button
            key={item}
            type="button"
            aria-pressed={selected}
            title={`${LABELS[item]} theme`}
            onClick={() => apply(item)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors ${
              selected
                ? 'bg-white text-zinc-900 shadow-sm'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
            }`}
          >
            <Icon choice={item} />
            <span className={labels ? '' : 'sr-only'}>{LABELS[item]}</span>
          </button>
        );
      })}
    </div>
  );
}
