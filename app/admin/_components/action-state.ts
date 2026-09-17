/** Result of a form-bound admin server action, surfaced via `useActionState`. */
export type ActionState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; message: string };

export const IDLE_ACTION: ActionState = { status: 'idle' };

/** Shared control styling so every admin form looks the same. */
export const INPUT_CLASS =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none';

export const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';

export const BUTTON_CLASS =
  'inline-flex items-center justify-center rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-50';

export const BUTTON_SUBTLE_CLASS =
  'inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50';
