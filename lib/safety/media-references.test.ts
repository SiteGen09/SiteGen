import { describe, expect, it } from 'vitest';
import { collectInput, downloadReference, isPublicAddress, rewriteInput, sniffKind } from './media-references';

describe('collectInput', () => {
  it('separates text, URLs and task references', () => {
    const collected = collectInput({
      prompt: 'a red fox',
      negative_prompt: 'blurry',
      image_urls: ['https://example.com/a.png', 'data:image/png;base64,AAAA'],
      video_list: [{ url: 'https://example.com/b.mp4', start: 0 }],
      taskId: 'task-123',
    });
    expect(collected.text).toBe('a red fox\nnegative_prompt: blurry');
    expect(collected.urls.map((ref) => ref.path)).toEqual([['image_urls', 0], ['image_urls', 1], ['video_list', 0, 'url']]);
    expect(collected.tasks).toEqual([{ path: ['taskId'], key: 'taskId', value: 'task-123' }]);
  });

  it('screens every text field, not just the prompt', () => {
    expect(collectInput({ prompt: 'a cat', style: 'nsfw' }).text).toContain('style: nsfw');
  });
});

describe('rewriteInput', () => {
  it('replaces the references without touching the original', () => {
    const input = { prompt: 'x', image_urls: ['https://a', 'https://b'] };
    const rewritten = rewriteInput(input, [{ path: ['image_urls', 1], value: 'https://checked' }]);
    expect(rewritten.image_urls).toEqual(['https://a', 'https://checked']);
    expect(input.image_urls[1]).toBe('https://b');
  });
});

describe('isPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '103.102.166.240', '2606:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('downloadReference', () => {
  it.each([
    ['file:///etc/passwd', /http or https/],
    ['http://127.0.0.1/secret', /public host/],
    ['http://169.254.169.254/latest/meta-data/', /public host/],
    ['http://[::1]/', /public host/],
    ['http://localhost/x', /public host/],
    ['http://printer.local/x', /public host/],
    ['https://user:pass@example.com/x.png', /credentials/],
  ])('refuses %s', async (url, message) => {
    await expect(downloadReference(url, 1_000_000)).rejects.toThrow(message);
  });

  it('decodes a data URL within the size limit', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const loaded = await downloadReference(`data:image/png;base64,${png.toString('base64')}`, 1_000);
    expect(loaded.bytes.equals(png)).toBe(true);
    await expect(downloadReference(`data:image/png;base64,${png.toString('base64')}`, 4)).rejects.toThrow(/too large/);
  });
});

describe('sniffKind', () => {
  it('trusts the bytes, not the name', () => {
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image');
    expect(sniffKind(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0', 'latin1'))).toBe('video');
    expect(sniffKind(Buffer.from('ID3\x04\0\0\0\0\0\0\0\0', 'latin1'))).toBe('audio');
    expect(sniffKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8'))).toBeNull();
  });
});
