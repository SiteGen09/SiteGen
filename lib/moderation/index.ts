/**
 * Provider-agnostic content moderation.
 *
 * The gateway checks a request before any upstream model call, so a flagged
 * prompt is rejected without being billed. The interface is deliberately small
 * — one method that returns a decision — so the provider behind it can change
 * without touching the route.
 */
export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export interface ModerationProvider {
  check(text: string): Promise<ModerationResult>;
}

/** Never flags. Used when no moderation key is configured. */
export const ALLOW_ALL: ModerationProvider = {
  check: async () => ({ flagged: false, categories: [] }),
};

export { openAiModeration } from './openai';
export { getModerationProvider } from './provider';
export type { ModerationProvider as Provider };
export { checkContent } from './check';