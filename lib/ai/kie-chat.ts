import { kieCreditsIn, type CostMeter } from '@/lib/ai/upstream-cost';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withoutLength(headers: Headers): Headers {
  const copy = new Headers(headers);
  copy.delete('content-length');
  copy.delete('content-encoding');
  return copy;
}

/**
 * Kie's chat stream can send text and usage followed by [DONE], without ever
 * sending finish_reason. Normalize that terminal marker before the SDK parses
 * the stream. EOF alone must never turn an interrupted response into success.
 *
 * With a `meter`, the `credits_consumed` kie.ai reports on each reply is
 * recorded there for settlement (see lib/ai/upstream-cost.ts).
 */
export function createKieChatFetch(meter?: CostMeter): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname !== '/v1/chat/completions' || !response.ok || response.body === null) return response;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('text/event-stream')) {
      if (!meter || !contentType.includes('json')) return response;
      const text = await response.text();
      try {
        const credits = kieCreditsIn(JSON.parse(text));
        if (credits !== undefined) meter.addCredits(credits);
      } catch {
        // The SDK reports malformed bodies; the cost is simply unknown.
      }
      return new Response(text, { status: response.status, statusText: response.statusText, headers: withoutLength(response.headers) });
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    let sawOutput = false;
    let sawToolCalls = false;
    let sawFinish = false;
    let sawError = false;
    let credits: number | undefined;

    function normalize(frame: string): string {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) return frame;

      if (data === '[DONE]') {
        if (!sawFinish && sawOutput && !sawError) {
          sawFinish = true;
          const finish = {
            choices: [{
              index: 0,
              delta: {},
              finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
            }],
          };
          return 'data: ' + JSON.stringify(finish) + '\n\n' + frame;
        }
        return frame;
      }

      try {
        const chunk = record(JSON.parse(data));
        credits = kieCreditsIn(chunk) ?? credits;
        if (!chunk || 'error' in chunk || (typeof chunk.code === 'number' && chunk.code !== 200)) {
          sawError = true;
          return frame;
        }
        const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
        if (typeof choice?.finish_reason === 'string') sawFinish = true;
        const delta = record(choice?.delta);
        if (delta) {
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) sawToolCalls = true;
          sawOutput ||= sawToolCalls || [delta.content, delta.reasoning_content, delta.reasoning]
            .some((value) => typeof value === 'string' && value.length > 0);
        }
      } catch {
        // Leave malformed frames to the SDK's validation and error reporting.
        sawError = true;
      }
      return frame;
    }

    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          controller.enqueue(encoder.encode(normalize(frame) + boundary[0]));
        }
      },
      flush(controller) {
        // An unterminated frame is not an SSE event; forward it without using it
        // as evidence of completion. Preserve all provider usage figures as-is.
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(pending));
        // Once per response, before the SDK sees the end of the stream and
        // resolves usage: kie repeats nothing, but a response is one charge.
        if (credits !== undefined) meter?.addCredits(credits);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: withoutLength(response.headers) });
  };
}

export const kieChatFetch: typeof fetch = createKieChatFetch();
