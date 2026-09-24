/**
 * kie.ai's Responses endpoint speaks SSE even when a caller asks the OpenAI
 * SDK for a single generated result. The SDK's non-streaming operation expects
 * one JSON response, while its streaming operation expects SSE. Keep the
 * protocol translation at the transport boundary so both operations work.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Kie omits OpenAI's required empty annotations array on plain text parts. */
function normalizeOutputText(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOutputText);
  const record = asRecord(value);
  if (record === undefined) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    normalized[key] = normalizeOutputText(child);
  }
  if (normalized.type === 'output_text' && !Array.isArray(normalized.annotations)) {
    normalized.annotations = [];
  }
  return normalized;
}

function normalizeSseFrame(frame: string): string {
  const lines = frame
    .split(/\r?\n/)
    .map((line) => line.startsWith('event:') ? `event: ${line.slice(6).trimStart()}`
      : line.startsWith('data:') ? `data: ${line.slice(5).replace(/^ /, '')}`
        : line);
  const dataLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('data:'));
  if (dataLines.length === 0) return lines.join('\n');

  try {
    const data = dataLines.map(({ line }) => line.slice(5).replace(/^ /, '')).join('\n');
    const normalizedData = JSON.stringify(normalizeOutputText(JSON.parse(data)));
    let inserted = false;
    return lines
      .flatMap((line) => {
        if (!line.startsWith('data:')) return [line];
        if (inserted) return [];
        inserted = true;
        return [`data: ${normalizedData}`];
      })
      .join('\n');
  } catch {
    return lines.join('\n');
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

function parseEvents(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      let event: string | undefined;
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trimStart();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      return { event, data: data.join('\n') };
    })
    .filter((event) => event.data.length > 0);
}

function responseError(message: string, status: number, headers: Headers): Response {
  const clean = new Headers(headers);
  clean.delete('content-length');
  clean.delete('content-encoding');
  clean.set('content-type', 'application/json; charset=utf-8');
  return Response.json({ error: { message, type: 'upstream_error' } }, { status, headers: clean });
}

/** Turn a Responses SSE stream into the terminal JSON object expected by doGenerate. */
export async function kieResponsesJson(response: Response): Promise<Response> {
  const events = parseEvents(await response.text());
  let failure: string | undefined;
  for (const event of events) {
    let value: Record<string, unknown> | undefined;
    try {
      value = asRecord(JSON.parse(event.data));
    } catch {
      continue;
    }
    if (value === undefined) continue;
    const type = typeof value.type === 'string' ? value.type : event.event;
    if (type === 'response.completed') {
      const result = asRecord(value.response);
      if (result !== undefined) {
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        headers.set('content-type', 'application/json; charset=utf-8');
        return Response.json(normalizeOutputText(result), { status: response.status, headers });
      }
    }
    if (type === 'response.incomplete') {
      const result = asRecord(value.response);
      const details = asRecord(result?.incomplete_details);
      failure = typeof details?.reason === 'string'
        ? `kie.ai Responses request was incomplete: ${details.reason}`
        : 'kie.ai Responses request was incomplete';
    }
    if (type === 'response.failed' || type === 'error') {
      const error = asRecord(value.error) ?? asRecord(asRecord(value.response)?.error);
      failure = typeof error?.message === 'string' ? error.message : 'kie.ai Responses request failed';
    }
  }
  return responseError(failure ?? 'kie.ai Responses stream ended without a completed response', 502, response.headers);
}

/** Normalize Kie's valid-but-unusual `event:x` / `data:y` spacing for SSE parsers. */
export const kieResponsesFetch: typeof fetch = async (input, init) => {
  let requestBody: Record<string, unknown> | undefined;
  try {
    const body = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : undefined;
    requestBody = body === undefined ? undefined : asRecord(JSON.parse(body));
  } catch {
    // The upstream request still owns validation of malformed or streaming
    // bodies; only a readable JSON body is needed to detect SDK stream mode.
  }

  const response = await fetch(input, init);
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (
    url.hostname !== 'api.kie.ai' ||
    !url.pathname.endsWith('/responses') ||
    !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
    response.body === null
  ) {
    return response;
  }

  // A non-stream request must be buffered and converted to the terminal
  // Responses object. Streaming stays live and is only normalized line-wise.
  if (requestBody?.stream !== true) return kieResponsesJson(response);

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const normalized = normalizeSseFrame(frame);
        controller.enqueue(encoder.encode(normalized + boundary[0]));
      }
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(pending));
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
};
