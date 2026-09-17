import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Rejects any string carrying angle brackets. The brief is rendered back into
 * generated HTML copy, so `<` / `>` never belong in a validated request even
 * after escaping — matches the spec schema's `HTML_CHARS` guard.
 */
const HTML_CHARS = /[<>]/;

function plainText(min: number, max: number) {
  return z
    .string()
    .trim()
    .min(min, `must be at least ${min} character(s)`)
    .max(max, `must be at most ${max} characters`)
    .refine((value) => !HTML_CHARS.test(value), { message: 'must not contain "<" or ">"' });
}

/**
 * Free-form extra brief fields. Bounded in count and value size so a request
 * cannot smuggle an unbounded prompt through the escape hatch.
 */
const detailsSchema = z
  .record(plainText(1, 60), plainText(1, 500))
  .refine((record) => Object.keys(record).length <= 20, {
    message: 'must have at most 20 entries',
  });

export const generateRequestSchema = z.strictObject({
  businessName: plainText(1, 120),
  businessType: plainText(1, 60),
  description: plainText(1, 2000),
  language: plainText(2, 12).default('en'),
  details: detailsSchema.optional(),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;

/**
 * Stable serialization of a validated request. Object keys are emitted in
 * sorted order at every level so two structurally identical bodies hash the
 * same regardless of field order on the wire.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

/** SHA-256 of the canonicalized request, binding an idempotency key to a body. */
export function requestHash(request: GenerateRequest): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(request)), 'utf8').digest('hex');
}
