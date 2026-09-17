/**
 * Theme preference: "light", "dark", or "system" (follow the device).
 *
 * The palette itself lives in `app/globals.css`, where every colour token is a
 * `light-dark()` pair keyed off `color-scheme`. That means CSS already does the
 * right thing for a visitor who has never touched the switch — all this module
 * has to persist is an explicit override.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'sitegen-theme';

export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'system', 'dark'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Runs before first paint, inlined in the document head. "system" writes no
 * attribute at all, so the `prefers-color-scheme` rule in the stylesheet stays
 * in charge and there is nothing to flash. Kept free of modern syntax and
 * wrapped in try/catch because storage throws outright in some privacy modes.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);}}catch(e){}})();`;
