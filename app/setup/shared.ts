export type OsKey = 'windows' | 'macos' | 'linux';

/**
 * Setup pages are public, so every sample carries a placeholder rather than a
 * live key. It matches the shape the dashboard issues, which keeps the
 * length-sensitive fields in editor settings honest.
 */
export const KEY_PLACEHOLDER = 'sk_live_YOUR_API_KEY_HERE';
