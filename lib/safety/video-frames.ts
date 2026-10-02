import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Still frames from a video, so the image classifier can judge it.
 *
 * None of the safety models accept video, so a video is screened as a set of
 * frames spread across its length. This needs ffmpeg on the host
 * (`FFMPEG_PATH`, or `ffmpeg` on PATH). Without it, video generation stays
 * off: an unscreened video is never shown.
 */

let resolved: string | null | undefined;

export function ffmpegPath(): string | null {
  if (resolved !== undefined) return resolved;
  const configured = process.env.FFMPEG_PATH?.trim();
  const candidate = configured || 'ffmpeg';
  if (configured && !existsSync(configured)) {
    resolved = null;
    return resolved;
  }
  const probe = spawnSync(candidate, ['-hide_banner', '-version'], { timeout: 10_000, windowsHide: true });
  resolved = probe.status === 0 ? candidate : null;
  return resolved;
}

/** Test seam. */
export function resetFfmpegPath(): void {
  resolved = undefined;
}

export function videoScreeningAvailable(): boolean {
  return ffmpegPath() !== null;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Duration in seconds, read from ffmpeg's own banner. */
function durationOf(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (match === null) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Up to `count` JPEG frames, evenly spaced and at most 768 px wide. Throws when
 * ffmpeg is missing or the bytes are not a readable video.
 */
export async function extractVideoFrames(bytes: Uint8Array, count = 8): Promise<Buffer[]> {
  const binary = ffmpegPath();
  if (binary === null) throw new Error('ffmpeg is not available');
  const dir = await mkdtemp(join(tmpdir(), 'sitegen-frames-'));
  try {
    const source = join(dir, 'source');
    await writeFile(source, bytes);
    const probe = await run(binary, ['-hide_banner', '-i', source], 30_000);
    const duration = durationOf(probe.stderr);
    if (duration === null || !(duration > 0)) throw new Error('not a readable video');
    // Frames at the middle of `count` equal slices, so the first and last
    // moments are covered without sampling a black lead-in frame.
    const fps = count / Math.max(duration, 0.5);
    const result = await run(binary, [
      '-hide_banner', '-loglevel', 'error', '-i', source,
      '-vf', `fps=${fps.toFixed(6)}:start_time=${(duration / count / 2).toFixed(3)},scale='min(768,iw)':-2`,
      '-frames:v', String(count), '-q:v', '4', join(dir, 'frame-%02d.jpg'),
    ], 120_000);
    if (result.code !== 0) throw new Error('frame extraction failed');
    const frames = (await readdir(dir)).filter((name) => name.startsWith('frame-')).sort();
    if (frames.length === 0) throw new Error('no frames extracted');
    return Promise.all(frames.map((name) => readFile(join(dir, name))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
