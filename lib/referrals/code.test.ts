import { describe, expect, it } from 'vitest';
import { normalizeReferralCode, referralLink } from './code';

describe('referral codes', () => {
  it('accepts codes in any case and trims them', () => {
    expect(normalizeReferralCode(' abcd2345 ')).toBe('ABCD2345');
  });

  it('rejects anything that cannot be a code', () => {
    for (const value of [undefined, null, 42, '', 'abc', 'A'.repeat(17), 'AB-CD-12', 'ABCD 1234']) {
      expect(normalizeReferralCode(value)).toBeNull();
    }
  });

  it('builds a signup link on the public site', () => {
    expect(referralLink('https://gensite.tech', 'ABCD2345')).toBe('https://gensite.tech/signup?ref=ABCD2345');
  });
});
