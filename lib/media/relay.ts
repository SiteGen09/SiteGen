import { isPolicyRejection } from '@/lib/guardrails/policy';
import { z } from 'zod';
import type { MediaChannelRow } from '@/lib/ai/channels';
import type { ProviderCreds } from '@/lib/ai/provider';
import { ApiError } from '@/lib/api/errors';
import { MediaSubmissionError } from '@/lib/media/fallback';

const inputSchema = z.object({
  prompt: z.string().trim().min(1).max(32000),
  size: z.string().regex(/^(auto|1K|2K|4K|\d{2,4}x\d{2,4})$/).default('1024x1024'),
  n: z.literal(1).default(1),
  quality: z.enum(['auto', 'low', 'medium', 'high']).optional(),
}).strict();

/** One image per job matches the existing storage and result contract. */
export function prepareRelayImage(channel: MediaChannelRow, input: Record<string, unknown>) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError('invalid_request', 'Relay images require a prompt, supported size, and n=1', 400);
  const prices = channel.billingPolicy?.imagePrices;
  if (!prices) throw new ApiError('channel_unavailable', 'image pricing is not configured', 503);
  const size = parsed.data.size;
  // Auto sizing is ambiguous for a size-priced model; use an explicit size.
  if (size === 'auto' && prices.standard !== prices.large) throw new ApiError('invalid_request', 'choose an explicit image size for this model', 400);
  const dimensions = size.split('x').map(Number);
  const large = size === '2K' || size === '4K' || dimensions.some(n => n > 1792);
  return { input: parsed.data, costUsd: large ? prices.large : prices.standard };
}

export const relayImageResultSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).length(1),
});
export type RelayImageResult = z.infer<typeof relayImageResultSchema>;

export async function generateRelayImage(creds: ProviderCreds, model: string, input: Record<string, unknown>): Promise<RelayImageResult> {
  if (creds.provider !== 'openai_images' || creds.baseUrl !== 'https://relay.fast/v1') throw new Error('Invalid Relay image endpoint');
  const response = await fetch(`${creds.baseUrl}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, model, n: 1, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok && isPolicyRejection(await response.clone().json().catch(() => null))) throw new ApiError('content_policy_violation', 'the provider rejected this request under its content policy', 400);
  if (!response.ok) throw new MediaSubmissionError(`Relay image request failed (HTTP ${response.status})`, response.status);
  const result = relayImageResultSchema.safeParse(await response.json());
  if (!result.success) throw new ApiError('channel_unavailable', 'Relay returned no image data', 502);
  return result.data;
}
