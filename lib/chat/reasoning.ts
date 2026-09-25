/**
 * How hard the model should think before answering, in the AI SDK's standard
 * scale; each provider adapter translates it to its own wire field
 * (`reasoning_effort`, `reasoning.effort`, a thinking budget).
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

const EFFORTS: Record<string, ReasoningEffort> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  // Clients that go past xhigh get the highest level the SDK knows.
  max: 'xhigh',
};

/**
 * The effort a client asked for, or undefined to leave the provider's default.
 * Unknown values are ignored rather than rejected: a newer client naming a
 * level this gateway does not know should still be served.
 */
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' ? EFFORTS[value.toLowerCase()] : undefined;
}
