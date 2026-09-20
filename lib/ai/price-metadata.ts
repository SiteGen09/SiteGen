import { z } from 'zod';

/** Form and server share normalization; empty list prices mean unpublished. */
const optionalRate = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : Number(v)))
  .pipe(z.number().finite().nonnegative().max(999999.999999).nullable())
  .transform((value) => (value === null ? null : Math.round(value * 1_000_000) / 1_000_000));
const labels = z
  .string()
  .transform((v) => [
    ...new Set(
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ])
  .pipe(
    z
      .array(
        z
          .string()
          .max(80)
          .regex(/^[a-zA-Z0-9._ -]+$/),
      )
      .max(30),
  );
export const priceMetadataFields = {
  vendor: z
    .string()
    .trim()
    .max(80)
    .regex(/^[a-z0-9-]*$/)
    .transform((v) => v || null),
  contextWindow: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : Number(v)))
    .pipe(z.number().int().positive().max(2147483647).nullable()),
  endpoints: labels,
  tags: labels,
  pricingType: z.enum(['token', 'request']),
  listInputPerMTok: optionalRate,
  listOutputPerMTok: optionalRate,
  listCachedPerMTok: optionalRate,
};
