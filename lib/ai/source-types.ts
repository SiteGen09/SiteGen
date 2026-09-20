export const FAMILIES = ['gpt', 'claude', 'grok'] as const;
export type Family = (typeof FAMILIES)[number];
export type RoutingPreferences = ReadonlyMap<Family, string>;
