/**
 * Single source of truth for model ids. Business logic must reference
 * `MODELS.strong` / `MODELS.cheap` and never a raw model string.
 */
export const MODELS = {
  strong: 'claude-opus-4-20250514',
  cheap: 'claude-3-5-haiku-20241022',
} as const;

export type ModelTier = keyof typeof MODELS;

export type KnownModelId = (typeof MODELS)[ModelTier];
