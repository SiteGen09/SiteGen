import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { MediaSubmissionError, submitWithFallback } from './fallback';

describe('media submission fallback', () => {
  it('tries another provider when a submission is explicitly refused', async () => {
    const attempt = vi.fn(async (provider: string) => {
      if (provider === 'first') throw new MediaSubmissionError('unavailable', 503);
      return 'task-id';
    });
    expect(await submitWithFallback(['first', 'second'], attempt)).toBe('task-id');
    expect(attempt.mock.calls.map(([provider]) => provider)).toEqual(['first', 'second']);
  });
  it('never tries another provider after an accepted task', async () => {
    const attempt = vi.fn(async () => 'accepted-task-id');
    expect(await submitWithFallback(['first', 'second'], attempt)).toBe('accepted-task-id');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('does not replay ambiguous timeouts, validation failures, or policy rejections', async () => {
    const errors = [
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      new ApiError('channel_unavailable', 'response lost', 502),
      new MediaSubmissionError('invalid input', 422),
      new ApiError('content_policy_violation', 'blocked', 400),
    ];
    for (const error of errors) {
      const attempt = vi.fn(async () => { throw error; });
      await expect(submitWithFallback(['first', 'second'], attempt)).rejects.toBe(error);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });
});
