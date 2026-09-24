import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve('next/package.json'));
const sharp = nextRequire('sharp');
const source = new URL('../public/brand/sitegen-mark.svg', import.meta.url);
const mark = await readFile(source);

async function appIcon(size) {
  const markSize = Math.round(size * 0.7);
  const inset = Math.floor((size - markSize) / 2);
  const logo = await sharp(mark).resize(markSize, markSize).png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: '#08090b' },
  }).composite([{ input: logo, left: inset, top: inset }]).png().toBuffer();
}

await writeFile(new URL('../public/brand/sitegen-mark.png', import.meta.url), await sharp(mark).resize(512, 512).png().toBuffer());
await writeFile(new URL('../app/apple-icon.png', import.meta.url), await appIcon(180));

// PNG frames inside an ICO keep the mark sharp at common browser tab sizes.
const sizes = [16, 32, 48, 64, 256];
const frames = await Promise.all(sizes.map(appIcon));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
for (const [index, frame] of frames.entries()) {
  const entry = 6 + index * 16;
  header[entry] = sizes[index] === 256 ? 0 : sizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frame.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}
await writeFile(new URL('../app/favicon.ico', import.meta.url), Buffer.concat([header, ...frames]));
console.log('Generated sitegen PNG, Apple touch icon, and multi-size favicon.');
