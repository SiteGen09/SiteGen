import { describe, expect, it } from 'vitest';

import { capAttachments, MAX_ATTACHMENTS, type ChatAttachment } from './attachments';

type Message = { role: 'user' | 'tool'; content?: string | null; attachments?: ChatAttachment[] };

function image(n: number): ChatAttachment {
  return { data: `data:image/png;base64,${n}`, mediaType: 'image/png' };
}

/** One tool result per screenshot, as a long Claude Code session sends them. */
function screenshots(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({ role: 'tool', content: '', attachments: [image(i)] }));
}

function attachmentCount(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0);
}

describe('capAttachments', () => {
  it('leaves a conversation at the limit untouched', () => {
    const messages = screenshots(MAX_ATTACHMENTS);
    expect(capAttachments(messages)).toBe(messages);
  });

  it('drops the oldest attachments past the limit, keeping the newest', () => {
    const capped = capAttachments(screenshots(MAX_ATTACHMENTS + 1));
    expect(attachmentCount(capped)).toBeLessThanOrEqual(MAX_ATTACHMENTS);
    expect(capped.at(-1)?.attachments).toEqual([image(MAX_ATTACHMENTS)]);
    expect(capped[0]?.attachments).toBeUndefined();
  });

  it('leaves a note where an attachment was removed', () => {
    const [first] = capAttachments(screenshots(MAX_ATTACHMENTS + 1));
    expect(first).toEqual({ role: 'tool', content: expect.stringMatching(/^\[1 image or file was removed here/) });
  });

  it('appends the note after text the message already had', () => {
    const messages: Message[] = [
      { role: 'user', content: 'What changed?', attachments: [image(0), image(1)] },
      ...screenshots(MAX_ATTACHMENTS),
    ];
    const [first] = capAttachments(messages);
    expect(first?.content).toMatch(/^What changed\?\n\n\[2 images or files were removed here/);
    expect(first?.attachments).toBeUndefined();
  });

  it('drops from the front of a message that carries several', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Compare', attachments: Array.from({ length: 15 }, (_, i) => image(i)) },
      ...screenshots(MAX_ATTACHMENTS - 10),
    ];
    // 105 in all: one step of 10 goes, from the start of the first message.
    expect(capAttachments(messages)[0]?.attachments).toEqual(Array.from({ length: 5 }, (_, i) => image(i + 10)));
  });

  it('drops in steps so the trimmed history stays stable across turns', () => {
    const one = capAttachments(screenshots(MAX_ATTACHMENTS + 1));
    const nine = capAttachments(screenshots(MAX_ATTACHMENTS + 9));
    // Turns that add screenshots 101 to 110 all send the same trimmed prefix.
    expect(nine.slice(0, one.length)).toEqual(one);
    expect(attachmentCount(nine)).toBe(MAX_ATTACHMENTS - 1);
  });

  it('never refuses, however long the session grows', () => {
    const capped = capAttachments(screenshots(1000));
    expect(attachmentCount(capped)).toBeLessThanOrEqual(MAX_ATTACHMENTS);
    expect(capped.at(-1)?.attachments).toEqual([image(999)]);
  });
});
