import { describe, expect, it } from 'vitest';
import { readSseData } from './sse';

describe('SSE framing', () => {
  it('handles UTF-8 split byte by byte, CRLF, comments and multiple data lines', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: café\r\ndata: second\r\n\r\ndata: [DONE]\n\n');
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    const frames: string[] = [];
    for await (const frame of readSseData(stream)) frames.push(frame);
    expect(frames).toEqual(['café\nsecond', '[DONE]']);
  });
});
