import { z } from 'zod';

/**
 * Public request shape for `POST /v1/images` and `POST /v1/videos`.
 *
 * `input` is passed to the upstream close to verbatim, because each model
 * takes its own parameters — aspect ratio, resolution, background, duration,
 * reference images, audio ids, source clips — and enumerating them here would
 * mean a code change every time a model gains an option.
 *
 * What is enforced is the envelope: a prompt must be present, values must be
 * JSON-shaped, and the whole thing must stay small. The size cap is the real
 * protection — without it a caller could smuggle megabytes of base64 through
 * any field nobody thought to validate.
 */

/** Generous for prose, far below anything that would strain the upstream. */
const MAX_PROMPT_CHARS = 5_000;

/** Caps the whole input object once serialized. */
const MAX_INPUT_BYTES = 32_768;

const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * A flat record, for entries such as video's `video_list`, whose members are
 * objects: `[{ url, start, ends }]`. Nesting stops here — one level of objects
 * inside one level of arrays covers every documented model input, and a
 * recursive schema would accept payloads no model asked for.
 */
const jsonObject = z.record(z.string(), jsonScalar);

const inputValue = z.union([jsonScalar, z.array(z.union([jsonScalar, jsonObject])), jsonObject]);

export const mediaRequestSchema = z
  .object({
    model: z.string().trim().min(1, 'model is required'),
    input: z
      .object({ prompt: z.string().trim().min(1, 'input.prompt is required').max(MAX_PROMPT_CHARS) })
      .catchall(inputValue),
  })
  .superRefine((value, ctx) => {
    if (JSON.stringify(value.input).length > MAX_INPUT_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['input'],
        message: `input must serialize to under ${MAX_INPUT_BYTES} bytes`,
      });
    }
  });

export type MediaRequest = z.infer<typeof mediaRequestSchema>;
