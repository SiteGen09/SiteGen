export const FAMILIES = ['gpt', 'claude', 'grok', 'deepseek', 'qwen'] as const;
export type Family = (typeof FAMILIES)[number];
export type RoutingPreferences = ReadonlyMap<Family, string>;
