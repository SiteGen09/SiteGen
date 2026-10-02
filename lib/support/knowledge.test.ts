import { describe, expect, it } from 'vitest';

import { supportSystemPrompt } from './knowledge';

const base = {
  siteUrl: 'https://example.test',
  plan: 'pro',
  balanceCredits: 865000,
  activeKeys: 2,
  models: ['gpt-6-sol', 'claude-sonnet-5'],
  recentFailures: [],
};

describe('supportSystemPrompt', () => {
  it('uses the configured site for every endpoint and install command', () => {
    const prompt = supportSystemPrompt(base);
    expect(prompt).toContain('https://example.test/v1');
    expect(prompt).toContain('irm https://example.test/install.ps1 | iex');
    expect(prompt).toContain('curl -fsSL https://example.test/install.sh | sh');
  });

  it('tells the assistant new models need the installer re-run', () => {
    expect(supportSystemPrompt(base)).toMatch(/re-run the same install command to refresh the model list/);
  });

  it('describes the customer: plan, balance in credits and dollars, and models', () => {
    const prompt = supportSystemPrompt(base);
    expect(prompt).toContain('Plan: pro');
    expect(prompt).toContain('865,000 credits ($86.50)');
    expect(prompt).toContain('gpt-6-sol, claude-sonnet-5');
  });

  it('lists recent failures and survives unknown account facts', () => {
    const prompt = supportSystemPrompt({
      ...base,
      balanceCredits: null,
      activeKeys: null,
      models: [],
      recentFailures: [{ requestId: 'req-1', errorCode: 'unauthorized', at: '2026-09-26 10:00 UTC' }],
    });
    expect(prompt).toContain('Credit balance: unknown');
    expect(prompt).toContain('unauthorized at 2026-09-26 10:00 UTC (request req-1)');
    expect(prompt).toContain('Models available to this account: none right now.');
  });
});
