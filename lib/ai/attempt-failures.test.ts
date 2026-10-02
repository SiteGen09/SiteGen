import { describe, expect, it } from 'vitest';

import { failureCode, isProviderFailure, recordAttemptFailure } from './attempt-failures';

const httpError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

describe('isProviderFailure', () => {
  it('counts outages, rate limits, billing and missing-model errors against the provider', () => {
    for (const status of [500, 502, 503, 429, 402, 404, 401]) expect(isProviderFailure(httpError(status))).toBe(true);
    expect(isProviderFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('does not count the caller\'s own bad request', () => {
    for (const status of [400, 413, 422]) expect(isProviderFailure(httpError(status))).toBe(false);
  });
});

describe('failureCode', () => {
  it('names the status, or a network error when there is none', () => {
    expect(failureCode(httpError(503))).toBe('http_503');
    expect(failureCode(new Error('reset'))).toBe('network_error');
  });
});

describe('recordAttemptFailure', () => {
  it('never writes under the test runner', () => {
    expect(() => recordAttemptFailure('any-channel', httpError(503))).not.toThrow();
  });
});
