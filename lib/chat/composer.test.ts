import { describe, expect, it } from 'vitest';
import { attachmentsSchema, chooseModel, decodeTurn, detectMode, encodeTurn, readAttachment, supportsTextGeneration, turnText } from './composer';

describe('composer intent and models', () => {
  it('uses the explicit default and cheap replacements when it is unavailable', () => {
    const models = ['expensive-pro', 'gemini-3-8-flash-openai', 'gemini-3-6-flash-openai', 'gemini-3-5-flash-openai'];
    expect(chooseModel(models, 'chat')).toBe('gemini-3-5-flash-openai');
    expect(chooseModel(models.slice(0, 3), 'chat')).toBe('gemini-3-6-flash-openai');
    expect(chooseModel(models, 'chat', true)).toBe('gemini-3-5-flash-openai');
  });
  it.each([
    ['Create an image of a cat', 'image'],
    ['Can you generate a video of a forest?', 'video'],
    ['Please draw a cat', 'image'],
    ['Animate a sunrise', 'video'],
    ['Write a video script', 'chat'],
    ['How can I generate an image?', 'chat'],
    ['Create a video script for my business', 'chat'],
    ['Do not generate a video', 'chat'],
    ['Explain this image', 'chat'],
    ['What is a video codec?', 'chat'],
  ])('routes %s to %s', (prompt, kind) => expect(detectMode(prompt)).toBe(kind));

  it('picks an eligible model without leaking between catalogues', () => {
    expect(chooseModel(['text-only', 'gemini-flash'], 'chat', true)).toBe('gemini-flash');
    expect(chooseModel(['text-only'], 'chat', true)).toBe('');
    expect(chooseModel([], 'video')).toBe('');
    expect(chooseModel(['flux/image-to-image', 'qwen/text-to-image'], 'image')).toBe('qwen/text-to-image');
    expect(chooseModel(['sora/image-to-video'], 'video')).toBe('');
    expect(supportsTextGeneration('recraft/remove-background')).toBe(false);
  });
});

describe('attachments', () => {
  const files = [{ kind: 'text' as const, name: 'notes.txt', text: 'The launch is Friday.' }];
  it('persists and restores attachment content for later turns', () => {
    expect(decodeTurn(encodeTurn('Summarize', files))).toEqual({ text: 'Summarize', attachments: files });
    expect(turnText('Summarize', files)).toContain('The launch is Friday.');
    expect(decodeTurn('old message')).toEqual({ text: 'old message', attachments: [] });
    expect(decodeTurn('[[chat-attachments:v1]]invalid').attachments).toEqual([]);
  });
  it('rejects oversized, excessive, and unsafe attachments', () => {
    expect(attachmentsSchema.safeParse([...files, ...files, ...files, ...files]).success).toBe(false);
    expect(attachmentsSchema.safeParse([{ kind: 'image', name: 'a.svg', data: 'data:image/svg+xml;base64,AAAA' }]).success).toBe(false);
    expect(attachmentsSchema.safeParse([{ kind: 'image', name: 'a.png', data: 'https://example.com/image.png' }]).success).toBe(false);
    const large = { kind: 'image', name: 'a.png', data: 'data:image/png;base64,' + 'A'.repeat(1500000) };
    expect(attachmentsSchema.safeParse([large, large]).success).toBe(false);
  });
  it('reads text and rejects unsupported and binary files', async () => {
    expect(await readAttachment(new File(['hello'], 'hello.txt'))).toEqual({ kind: 'text', name: 'hello.txt', text: 'hello' });
    await expect(readAttachment(new File(['video'], 'clip.mp4'))).rejects.toThrow('not supported');
    await expect(readAttachment(new File(['\0binary'], 'binary.txt'))).rejects.toThrow('text file');
  });
});
