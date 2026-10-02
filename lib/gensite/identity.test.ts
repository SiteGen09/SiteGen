import { describe, expect, it } from 'vitest';

import { gensiteInstructions, withInstructions } from './identity';

describe('gensite identity', () => {
  it('names the product and the date, and forbids false claims about the models behind it', () => {
    const text = gensiteInstructions(new Date('2026-09-28T12:00:00Z'));
    expect(text).toContain('You are gensite-v1');
    expect(text).toContain('2026-09-28');
    expect(text).toContain('do not deny being built on third-party models');
  });

  it('goes before everything the caller sent, and is absent when not given', () => {
    const messages = [{ role: 'system' as const, content: 'caller system' }, { role: 'user' as const, content: 'hi' }];
    expect(withInstructions(messages, 'ours').map((message) => message.content)).toEqual(['ours', 'caller system', 'hi']);
    expect(withInstructions(messages, undefined)).toBe(messages);
  });

  it('puts a reminder after everything else, as a user turn', () => {
    const framed = withInstructions([{ role: 'user', content: 'hi' }], 'ours', 'you are looping');
    expect(framed.map((message) => message.role)).toEqual(['system', 'user', 'user']);
    expect(framed[2]!.content).toBe('<system-reminder>\nyou are looping\n</system-reminder>');
  });

  it('asks for decisive, efficient work and a professional bar for code and design', () => {
    const text = gensiteInstructions();
    expect(text).toContain('never repeat a call that already returned the same result');
    expect(text).toMatch(/Web and UI design/);
    expect(text).toContain('small verifiable edits');
    expect(text).toContain('visible keyboard focus');
  });
});
