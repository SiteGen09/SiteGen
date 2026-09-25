import { describe, expect, it } from 'vitest';

import { chatCompletionRequestSchema } from '@/lib/chat/request';
import { responsesRequestSchema } from '@/lib/responses/request';

import { parseReasoningEffort } from './reasoning';

describe('parseReasoningEffort', () => {
  it.each([
    ['low', 'low'],
    ['HIGH', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
    ['none', 'none'],
  ])('%s -> %s', (input, expected) => {
    expect(parseReasoningEffort(input)).toBe(expected);
  });

  it('leaves unknown or missing levels to the provider default', () => {
    expect(parseReasoningEffort('turbo')).toBeUndefined();
    expect(parseReasoningEffort(undefined)).toBeUndefined();
    expect(parseReasoningEffort(null)).toBeUndefined();
    expect(parseReasoningEffort(3)).toBeUndefined();
  });

  it('is read from both request shapes', () => {
    const responses = responsesRequestSchema.parse({
      model: 'm', input: 'hi', reasoning: { effort: 'low', summary: 'auto' },
    });
    expect(parseReasoningEffort(responses.reasoning?.effort)).toBe('low');

    const chat = chatCompletionRequestSchema.parse({
      model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium',
    });
    expect(parseReasoningEffort(chat.reasoning_effort)).toBe('medium');

    // Codex can send `reasoning: null`; that must not fail the request.
    expect(responsesRequestSchema.safeParse({ model: 'm', input: 'hi', reasoning: null }).success).toBe(true);
  });
});
