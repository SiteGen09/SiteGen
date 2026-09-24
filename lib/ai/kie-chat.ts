function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Kie's chat stream can send text and usage followed by [DONE], without ever
 * sending finish_reason. Normalize that terminal marker before the SDK parses
 * the stream. EOF alone must never turn an interrupted response into success.
 */
export const kieChatFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (
    url.pathname !== '/v1/chat/completions' ||
    !response.ok ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
    response.body === null
  ) {
    return response;
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let sawOutput = false;
  let sawToolCalls = false;
  let sawFinish = false;
  let sawError = false;

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
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
};
