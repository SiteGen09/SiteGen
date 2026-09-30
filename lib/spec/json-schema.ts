import { jsonSchema, type Schema } from 'ai';
import { z } from 'zod';

import { siteSpecSchema, type SiteSpec } from '@/lib/spec/schema';

type ProviderJsonSchema = Parameters<typeof jsonSchema>[0];

/**
 * Rewrites every `oneOf` to `anyOf`, in place of the caller's node.
 *
 * `sectionSchema` is a discriminated union, which serializes to `oneOf`.
 * OpenAI's structured-output validator rejects `oneOf` anywhere in a
 * `response_format` schema, so a spec request fails before the model runs.
 * `anyOf` is accepted and is equivalent here: the union is discriminated on
 * `type`, so at most one branch can ever match and the looser keyword cannot
 * admit a value that `oneOf` would have rejected.
 */
function oneOfToAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(oneOfToAnyOf);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key === 'oneOf' ? 'anyOf' : key] = oneOfToAnyOf(value);
  }
  return out;
}

/** The site spec as a JSON Schema the structured-output APIs will accept. */
export function siteSpecProviderSchema(): ProviderJsonSchema {
  const generated = z.toJSONSchema(siteSpecSchema, { target: 'draft-7', io: 'output' });
  return oneOfToAnyOf(generated) as ProviderJsonSchema;
}

/**
 * Provider-facing schema for spec generation.
 *
 * The JSON Schema is what the model is constrained by; validation stays on
 * `siteSpecSchema` so refinements the JSON Schema cannot express (id patterns,
 * HTML rejection, section count bounds) are still enforced on the response.
 */
export const siteSpecGenerationSchema: Schema<SiteSpec> = jsonSchema<SiteSpec>(
  siteSpecProviderSchema(),
  {
    validate: (value) => {
      const parsed = siteSpecSchema.safeParse(value);
      return parsed.success
        ? { success: true, value: parsed.data }
        : { success: false, error: parsed.error };
    },
  },
);

export { oneOfToAnyOf };
