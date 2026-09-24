/** Public site identity used in metadata and support links. */
export const SITE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://gensite.tech')
  .trim()
  .replace(/\/+$/, '');

/** Public support mailbox; safe to expose in rendered pages. */
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'admin@gensite.tech';
