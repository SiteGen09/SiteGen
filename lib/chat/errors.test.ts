import { describe, expect, it } from 'vitest';

import { canRetry, describeError, errorAction, transportError } from '@/lib/chat/errors';

describe('describeError', () => {
  it('quotes the shortfall and points at billing when credits run out', () => {
    const view = describeError({ code: 'insufficient_credits', message: 'insufficient credits: need 12000, balance 450', status: 402, required: 12000, balance: 450 });
    expect(view).toMatchObject({ kind: 'credits', title: 'Not enough credits' });
    expect(view.message).toContain('needs up to 12,000 credits, but your balance is 450');
    expect(errorAction(view.kind)).toEqual({ label: 'Add credits', href: '/dashboard/billing' });
  });

  it('says so plainly when the balance is empty', () => {
    const view = describeError({ code: 'insufficient_credits', message: '', status: 402, required: 80, balance: 0 });
    expect(view.message).toMatch(/^Your credit balance is empty/);
  });

  it('never shows internal or provider wording', () => {
    const cases = [
      { code: 'internal_error', message: 'credit operation failed: hold_credits', status: 500 },
      { code: 'channel_unavailable', message: 'the upstream provider rejected our credentials', status: 503 },
      { code: 'invalid_request', message: 'the model rejected this request: Invalid JSON at position 3', status: 400 },
      { code: 'generation_failed', message: 'the model returned an unusable response', status: 502 },
      { code: 'channel_unavailable', message: 'request protection is temporarily unavailable', status: 503 },
    ];
    for (const facts of cases) {
      const view = describeError(facts);
      expect(view.message).not.toMatch(/credential|upstream|JSON|hold_credits|protection/i);
      expect(view.title).not.toBe('');
    }
  });

  it('tells a rate-limited person how long to wait, and a paused one why', () => {
    expect(describeError({ code: 'rate_limited', message: 'too many requests', status: 429, retryAfter: 20 }).message)
      .toContain('Wait 20 seconds');
    expect(describeError({ code: 'rate_limited', message: 'generation is temporarily restricted after repeated policy violations', status: 429 }))
      .toMatchObject({ kind: 'paused' });
  });

  it('keeps dashboard-authored validation messages and tidies raw ones', () => {
    expect(describeError({ code: 'invalid_request', message: 'Attach up to 3 files per message.', status: 400 }).message)
      .toBe('Attach up to 3 files per message.');
    expect(describeError({ code: 'invalid_request', message: 'this conversation is full', status: 400 }).message)
      .toBe('This conversation is full.');
    expect(describeError({ code: 'invalid_request', message: 'request body is too large', status: 413 }).kind).toBe('too_large');
    expect(describeError({ code: 'invalid_request', message: 'Conversation unavailable or already answering.', status: 409 }).kind).toBe('busy');
  });

  it('separates our content policy from a provider refusal', () => {
    expect(describeError({ code: 'content_policy_violation', message: 'the prompt was flagged by content moderation', status: 400 }).title)
      .toBe('Message not allowed');
    expect(describeError({ code: 'content_policy_violation', message: 'the provider rejected this request under its content policy', status: 400 }).title)
      .toBe('Declined by the provider');
  });

  it('names the media kind that is switched off', () => {
    expect(describeError({ code: 'channel_unavailable', message: 'image generation requires tested remote prompt and output moderation', status: 503 }).message)
      .toBe("Image generation isn't available right now. Please try again later.");
  });
});

describe('transportError', () => {
  it('distinguishes offline from a gateway timeout', () => {
    expect(transportError().kind).toBe('network');
    expect(transportError(504)).toMatchObject({ kind: 'server', title: 'Server busy' });
    expect(transportError(401).kind).toBe('session');
    expect(transportError(413).kind).toBe('too_large');
  });
});

describe('canRetry', () => {
  it('does not offer to resend a reply that was already billed', () => {
    expect(canRetry('unsaved')).toBe(false);
    expect(canRetry('provider')).toBe(true);
    expect(canRetry('credits')).toBe(true);
  });
});
