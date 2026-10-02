import { describe, expect, it } from 'vitest';
import { isProviderBlock, isRefusal, parseVerdict } from './media-classifier';

/*
 * Probe notes (2026-09-29), which chose the default safety models:
 * - gemini-3.8-flash on the relay judged 16/16 benchmark prompts correctly
 *   (two by refusing at the provider, which counts as a block), median 7 s.
 * - Given an image URL it could not fetch, the same model described an image
 *   it invented ("a white puppy" for a cat). Images are therefore always sent
 *   as bytes, downloaded and checked by the gate itself.
 * - gpt-6-luna and deepseek-v4.1-flash timed out under parallel load.
 */

describe('parseVerdict', () => {
  it('reads allow and block verdicts', () => {
    expect(parseVerdict('{"verdict":"allow"}')).toEqual({ verdict: 'allow' });
    expect(parseVerdict('```json\n{"verdict": "block", "rule": "ip"}\n```')).toEqual({ verdict: 'block', rule: 'ip' });
  });

  it('keeps a block with an unknown rule as a block', () => {
    expect(parseVerdict('{"verdict":"block","rule":"something_new"}')).toEqual({ verdict: 'block', rule: 'unspecified' });
  });

  it('returns null without a verdict', () => {
    expect(parseVerdict('Sure! Here is a picture of a cat.')).toBeNull();
    expect(parseVerdict('{"verdict":"maybe"}')).toBeNull();
  });
});

describe('refusals', () => {
  it('treats a declining reply as a refusal', () => {
    expect(isRefusal("I'm sorry, but I can't help with that request.")).toBe(true);
    expect(isRefusal('The image shows a landscape.')).toBe(false);
  });

  it('treats a provider safety block as a block, not an outage', () => {
    expect(isProviderBlock({ responseBody: '{"error":{"code":"prompt_blocked","message":"request blocked by Gemini API: PROHIBITED_CONTENT"}}' })).toBe(true);
    expect(isProviderBlock({ message: 'fetch failed: ECONNRESET' })).toBe(false);
  });
});
