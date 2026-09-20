import { NoObjectGeneratedError, generateObject, type LanguageModelUsage } from 'ai';
import type * as Ai from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRow } from '@/lib/ai/fallback';
import { MODELS } from '@/lib/ai/models';
import { ApiError } from '@/lib/api/errors';
import { parseBearerKey, requireScope, type AuthenticatedKey } from '@/lib/api/api-key-auth';
import { costUsd, creditsForUsage } from '@/lib/ai/pricing';
import { HOLD_BUDGET, estimateHoldCredits } from '@/lib/generate/estimate';
import { generateSpec } from '@/lib/generate/generate';
import { generateRequestSchema, requestHash } from '@/lib/generate/request';
import { normalizeUsage } from '@/lib/generate/usage';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateObject: vi.fn() };
});

const generateObjectMock = vi.mocked(generateObject);

function lmUsage(input: number, output: number, cacheRead = 0): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: input - cacheRead,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
    totalTokens: input + output,
  };
}

/** Rates matching what the deleted PRICING constant carried for MODELS. */
const CHEAP_RATES = { inputPerMTok: 0.8, outputPerMTok: 4, cachedPerMTok: 0.08 };
const STRONG_RATES = { inputPerMTok: 15, outputPerMTok: 75, cachedPerMTok: 1.5 };

function cheapChannel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'spec-cheap',
    provider: 'anthropic',
    baseUrl: null,
    modelId: MODELS.cheap,
    creditMultiplier: '1.00',
    isByok: false,
    status: 'active',
    fallbackTo: null,
    rates: CHEAP_RATES,
    ...overrides,
  };
}

const FAKE_SPEC = { marker: 'site-spec' } as const;
const CREDS = { provider: 'anthropic', apiKey: 'sk-test', baseUrl: null } as const;

function validationError(usage: LanguageModelUsage): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'response did not match schema',
    cause: new Error('meta.title: required'),
    text: '{}',
    response: { id: 'r1', timestamp: new Date(0), modelId: MODELS.cheap },
    usage,
    finishReason: 'stop',
  });
}

describe('generateSpec', () => {
  beforeEach(() => {
    generateObjectMock.mockReset();
  });

  it('returns the spec, serving channel, and usage on first success', async () => {
    generateObjectMock.mockResolvedValue({
      object: FAKE_SPEC,
      usage: lmUsage(1000, 500),
      providerMetadata: undefined,
    } as never);

    const result = await generateSpec({
      start: cheapChannel(),
      resolve: async () => null,
      buildCreds: async () => CREDS,
      prompt: 'brief',
      maxOutputTokens: 8000,
    });

    expect(result.spec).toBe(FAKE_SPEC);
    expect(result.channelId).toBe('spec-cheap');
    expect(result.modelId).toBe(MODELS.cheap);
    expect(result.multiplier).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cachedTokens: 0 });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it('retries once with the validation error appended, then succeeds', async () => {
    generateObjectMock
      .mockRejectedValueOnce(validationError(lmUsage(100, 0)))
      .mockResolvedValueOnce({
        object: FAKE_SPEC,
        usage: lmUsage(1000, 500),
        providerMetadata: undefined,
      } as never);

    const result = await generateSpec({
      start: cheapChannel(),
      resolve: async () => null,
      buildCreds: async () => CREDS,
      prompt: 'brief',
      maxOutputTokens: 8000,
    });

    expect(result.spec).toBe(FAKE_SPEC);
    // Usage from the failed attempt is still counted for settlement.
    expect(result.usage).toEqual({ inputTokens: 1100, outputTokens: 500, cachedTokens: 0 });
    expect(generateObjectMock).toHaveBeenCalledTimes(2);

    const secondCall = generateObjectMock.mock.calls[1]?.[0];
    expect(String(secondCall?.prompt)).toContain('failed schema validation');
    expect(String(secondCall?.prompt)).toContain('meta.title: required');
  });

  it('throws generation_failed after two validation failures', async () => {
    generateObjectMock.mockRejectedValue(validationError(lmUsage(100, 0)));

    await expect(
      generateSpec({
        start: cheapChannel(),
        resolve: async () => null,
        buildCreds: async () => CREDS,
        prompt: 'brief',
        maxOutputTokens: 8000,
      }),
    ).rejects.toMatchObject({ code: 'generation_failed', status: 502 });
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-validation error without retrying', async () => {
    generateObjectMock.mockRejectedValue(new ApiError('invalid_request', 'boom', 400));

    await expect(
      generateSpec({
        start: cheapChannel(),
        resolve: async () => null,
        buildCreds: async () => CREDS,
        prompt: 'brief',
        maxOutputTokens: 8000,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });
});

describe('estimateHoldCredits', () => {
  it('sizes the hold from the worst-case budget across every billable round', () => {
    // Two rounds of (10000*0.8 + 8000*4)/1e6 = 0.08 USD -> ceil(800 * 1.0) = 800.
    expect(estimateHoldCredits(cheapChannel())).toBe(800);
  });

  it('applies the channel multiplier', () => {
    // Two rounds of (10000*15 + 8000*75)/1e6 = 1.5 USD -> ceil(15000 * 1.2) = 18000.
    const strong = cheapChannel({ rates: STRONG_RATES, creditMultiplier: '1.20' });
    expect(estimateHoldCredits(strong)).toBe(18000);
  });

  it('holds nothing for a zero-multiplier BYOK channel', () => {
    expect(estimateHoldCredits(cheapChannel({ creditMultiplier: '0', isByok: true }))).toBe(0);
  });

  it('rejects a channel with an invalid multiplier', () => {
    expect(() => estimateHoldCredits(cheapChannel({ creditMultiplier: 'nope' }))).toThrow(
      expect.objectContaining({ code: 'channel_unavailable', status: 503 }),
    );
  });

  it('prices from the channel rates, not the model id', () => {
    // The same model id at different rates must hold differently — pricing is
    // per channel now, so a model id no longer implies a price.
    const cheap = cheapChannel({ rates: CHEAP_RATES });
    const pricey = cheapChannel({ rates: STRONG_RATES });
    expect(estimateHoldCredits(pricey)).toBeGreaterThan(estimateHoldCredits(cheap));
  });
});

/**
 * Regression: a call that fails schema validation once and succeeds on the
 * retry settles usage from *both* attempts. The hold is placed once, before
 * either attempt, so it must cover the worst case for every round
 * `generateSpec` can run — otherwise settle drives the balance negative, which
 * is exactly the overdraw `hold_credits` refuses to allow but `settle_credits`
 * would happily write.
 */
describe('hold covers every round that settles', () => {
  it('a worst-case retry settles within the pre-flight hold', async () => {
    const channel = cheapChannel();
    const held = estimateHoldCredits(channel);

    generateObjectMock
      .mockRejectedValueOnce(validationError(lmUsage(10_000, 8_000)))
      .mockResolvedValueOnce({
        object: FAKE_SPEC,
        usage: lmUsage(10_000, 8_000),
        providerMetadata: undefined,
      } as never);

    const result = await generateSpec({
      start: channel,
      resolve: async () => null,
      buildCreds: async () => CREDS,
      prompt: 'brief',
      maxOutputTokens: HOLD_BUDGET.outputTokens,
    });

    // Both rounds are billed, at the full worst-case budget for each.
    expect(result.usage).toEqual({
      inputTokens: 20_000,
      outputTokens: 16_000,
      cachedTokens: 0,
    });

    const settled = creditsForUsage(costUsd(channel.rates, result.usage), 1);
    expect(settled).toBeLessThanOrEqual(held);
  });
});

describe('generateRequestSchema', () => {
  const valid = {
    businessName: 'Acme',
    businessType: 'SaaS',
    description: 'We sell widgets.',
  };

  it('parses a minimal body and defaults the language', () => {
    const parsed = generateRequestSchema.parse(valid);
    expect(parsed.language).toBe('en');
  });

  it('rejects HTML characters in any string field', () => {
    expect(generateRequestSchema.safeParse({ ...valid, businessName: 'Acme <b>' }).success).toBe(
      false,
    );
    expect(
      generateRequestSchema.safeParse({ ...valid, description: 'a > b' }).success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    expect(generateRequestSchema.safeParse({ businessType: 'SaaS' }).success).toBe(false);
  });

  it('rejects unknown keys and oversize fields', () => {
    expect(generateRequestSchema.safeParse({ ...valid, model: 'gpt' }).success).toBe(false);
    expect(
      generateRequestSchema.safeParse({ ...valid, businessName: 'x'.repeat(121) }).success,
    ).toBe(false);
  });

  it('bounds the details record', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(generateRequestSchema.safeParse({ ...valid, details: tooMany }).success).toBe(false);
    expect(
      generateRequestSchema.safeParse({ ...valid, details: { a: 'x'.repeat(501) } }).success,
    ).toBe(false);
  });
});

describe('requestHash', () => {
  it('is stable across detail key ordering', () => {
    const a = generateRequestSchema.parse({
      businessName: 'Acme',
      businessType: 'SaaS',
      description: 'copy',
      details: { alpha: '1', beta: '2' },
    });
    const b = generateRequestSchema.parse({
      businessName: 'Acme',
      businessType: 'SaaS',
      description: 'copy',
      details: { beta: '2', alpha: '1' },
    });
    expect(requestHash(a)).toBe(requestHash(b));
  });

  it('differs when the body differs', () => {
    const a = generateRequestSchema.parse({ ...valid(), description: 'one' });
    const b = generateRequestSchema.parse({ ...valid(), description: 'two' });
    expect(requestHash(a)).not.toBe(requestHash(b));
  });

  function valid() {
    return { businessName: 'Acme', businessType: 'SaaS', description: 'copy' };
  }
});

describe('normalizeUsage', () => {
  it('excludes cached tokens from the input count', () => {
    const usage = normalizeUsage(lmUsage(1000, 400, 250), undefined);
    expect(usage).toEqual({ inputTokens: 750, outputTokens: 400, cachedTokens: 250 });
  });

  it('falls back to anthropic provider metadata for cache reads', () => {
    const bare: LanguageModelUsage = {
      inputTokens: 1000,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: 400,
      outputTokenDetails: { textTokens: 400, reasoningTokens: 0 },
      totalTokens: 1400,
    };
    const usage = normalizeUsage(bare, { anthropic: { cacheReadInputTokens: 300 } });
    expect(usage).toEqual({ inputTokens: 700, outputTokens: 400, cachedTokens: 300 });
  });
});

describe('requireScope', () => {
  const auth: AuthenticatedKey = {
    apiKeyId: 'k1',
    ownerId: 'u1',
    rateLimitRpm: 60,
    scopes: ['generate'],
  };

  it('passes when the scope is granted', () => {
    expect(() => requireScope(auth, 'generate')).not.toThrow();
  });

  it('throws forbidden when the scope is missing', () => {
    expect(() => requireScope({ ...auth, scopes: ['read'] }, 'generate')).toThrow(
      expect.objectContaining({ code: 'forbidden', status: 403 }),
    );
  });
});

describe('parseBearerKey', () => {
  const key = `sk_live_${'A'.repeat(43)}`;

  it('extracts a well-formed bearer key', () => {
    expect(parseBearerKey(`Bearer ${key}`)).toBe(key);
  });

  it('rejects missing, malformed, or wrong-prefix headers', () => {
    for (const header of [null, 'Bearer ', 'Basic abc', `Bearer token_${'A'.repeat(43)}`, 'Bearer sk_live_short']) {
      expect(() => parseBearerKey(header)).toThrow(
        expect.objectContaining({ code: 'unauthorized', status: 401 }),
      );
    }
  });
});
