import { describe, expect, it } from 'vitest';

import { toUpstreamRecord } from '@/lib/media/kie';
import { mediaRequestSchema } from '@/lib/media/request';

/**
 * Shapes taken from a real job against api.kie.ai, so these pin the contract
 * as observed rather than as documented.
 */
const RESULT_URL = 'https://tempfile.aiquickdraw.com/images/chatgpt/file_0000.png';

function record(overrides: Record<string, unknown>) {
  return { taskId: 't1', state: 'generating', successFlag: 0, ...overrides };
}

describe('toUpstreamRecord', () => {
  it('reads an in-flight job as running', () => {
    expect(toUpstreamRecord(record({})).state).toBe('running');
  });

  it('unwraps the doubly-encoded result URL on success', () => {
    const result = toUpstreamRecord(
      record({
        state: 'success',
        successFlag: 1,
        resultJson: JSON.stringify({ resultUrls: [RESULT_URL] }),
        creditsConsumed: 6,
      }),
    );
    expect(result).toMatchObject({
      state: 'succeeded',
      imageUrl: RESULT_URL,
      upstreamCredits: 6,
    });
  });

  /**
   * The case that would otherwise charge for nothing: settling a job whose
   * image the caller can never fetch is worse than failing it, so a success
   * with an unusable body is downgraded rather than trusted.
   */
  it('treats a success with no usable URL as a failure', () => {
    for (const resultJson of ['', 'not json', '{}', '{"resultUrls":[]}']) {
      const result = toUpstreamRecord(record({ state: 'success', successFlag: 1, resultJson }));
      expect(result.state).toBe('failed');
      expect(result.errorCode).toBe('malformed_result');
    }
  });

  it('carries the upstream failure reason through', () => {
    const result = toUpstreamRecord(
      record({ state: 'fail', successFlag: 2, failCode: 422, failMsg: 'blocked prompt' }),
    );
    expect(result).toMatchObject({
      state: 'failed',
      errorCode: '422',
      errorMessage: 'blocked prompt',
      imageUrl: null,
    });
  });

  it('rejects a body it cannot read rather than guessing a state', () => {
    expect(() => toUpstreamRecord({ nope: true })).toThrow(/unreadable record/);
    expect(() => toUpstreamRecord(null)).toThrow(/unreadable record/);
  });
});

describe('mediaRequestSchema', () => {
  const valid = {
    model: 'gpt-image-2-5-flare',
    input: { prompt: 'a red circle', aspect_ratio: '3:2', resolution: '1K' },
  };

  it('passes model-specific options through untouched', () => {
    const parsed = mediaRequestSchema.parse(valid);
    expect(parsed.input).toEqual(valid.input);
  });

  it('requires a prompt, since no model generates without one', () => {
    expect(mediaRequestSchema.safeParse({ model: 'm', input: {} }).success).toBe(false);
    expect(mediaRequestSchema.safeParse({ model: 'm', input: { prompt: '  ' } }).success).toBe(
      false,
    );
  });

  it('refuses an oversized input rather than forwarding it upstream', () => {
    const parsed = mediaRequestSchema.safeParse({
      model: 'm',
      input: { prompt: 'x', blob: 'y'.repeat(40_000) },
    });
    expect(parsed.success).toBe(false);
  });

  /**
   * Video sends `video_list: [{ url, start, ends }]`, so arrays of flat
   * objects must pass. Anything deeper must not: nesting is where a payload
   * grows unbounded in ways the size cap alone would not catch early.
   */
  it('accepts the video input shape verbatim', () => {
    const parsed = mediaRequestSchema.safeParse({
      model: 'google/gemini-omni-flash-1-1',
      input: {
        prompt: 'a slow push-in on a neon street',
        image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
        audio_ids: ['audio_01hx8p0demo'],
        video_list: [{ url: 'https://example.com/v.mp4', start: 0, ends: 10 }],
        duration: '4',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('allows one level of object nesting and no more', () => {
    expect(
      mediaRequestSchema.safeParse({ model: 'm', input: { prompt: 'x', urls: ['a', 'b'] } }).success,
    ).toBe(true);
    expect(
      mediaRequestSchema.safeParse({ model: 'm', input: { prompt: 'x', deep: { a: { b: 1 } } } })
        .success,
    ).toBe(false);
    expect(
      mediaRequestSchema.safeParse({ model: 'm', input: { prompt: 'x', list: [{ a: { b: 1 } }] } })
        .success,
    ).toBe(false);
  });
});
