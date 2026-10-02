import { describe, expect, it } from 'vitest';

import { checkAttachments } from './attachments';

function file(name: string, bytes: number[] | string, type = ''): File {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return new File([data], name, { type });
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

describe('checkAttachments', () => {
  it('types files by their bytes, not their name or claimed type', async () => {
    const [shot] = await checkAttachments([file('screenshot.txt', PNG, 'text/plain')]);
    expect(shot?.mediaType).toBe('image/png');
  });

  it('accepts logs and configs as plain text', async () => {
    const checked = await checkAttachments([
      file('config.toml', 'model = "gpt"\n'),
      file('error.log', 'ECONNRESET\n'),
      file('body.json', '{"a":1}'),
    ]);
    expect(checked.map((entry) => entry.mediaType)).toEqual(['text/plain', 'text/plain', 'application/json']);
  });

  it('refuses markup a browser would render, whatever it is called', async () => {
    await expect(checkAttachments([file('page.html', '<script>alert(1)</script>', 'text/html')])).rejects.toThrow(
      /not a supported file/,
    );
    await expect(checkAttachments([file('logo.svg', '<svg onload="x()"/>', 'image/svg+xml')])).rejects.toThrow(
      /not a supported file/,
    );
  });

  it('refuses binary content posing as text', async () => {
    await expect(checkAttachments([file('notes.txt', [0x41, 0x00, 0x42])])).rejects.toThrow(/not a supported file/);
  });

  it('limits the number of files and ignores empty picks', async () => {
    const empty = file('empty.png', []);
    expect(await checkAttachments([empty])).toEqual([]);
    const four = Array.from({ length: 4 }, (_, index) => file(`${index}.png`, PNG));
    await expect(checkAttachments(four)).rejects.toThrow(/up to 3 files/);
  });

  it('strips paths and control characters from names', async () => {
    const [entry] = await checkAttachments([file('C:\\Users\\me\\sh"ot\u0007.png', PNG)]);
    expect(entry?.filename).toBe('shot.png');
  });
});
