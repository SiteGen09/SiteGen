import { logger } from '@/lib/log';

const log = logger({ component: 'tool-args-guard' });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCompleteJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

interface CallState {
  id: string | undefined;
  arguments: string;
}

/**
 * Some OpenAI-compatible relays occasionally repeat a tool call's whole
 * `arguments` after streaming it in fragments. The AI SDK appends everything
 * it gets for a call and only closes it at end of stream, so the client
 * receives `{...}{...}`, fails to parse it, and a coding agent retries the
 * same call forever. A JSON object or array is never complete until its last
 * fragment, so argument text arriving after the call already parses is
 * dropped here, before the SDK sees it.
 *
 * A fragment carrying a different id is a new call, never a repeat, and is
 * left alone.
 */
export function createToolArgsGuard(): (frame: string) => string {
  // Looked up the way the SDK's tool-call tracker does: by id when the
  // fragment has one, else by index, else the most recent call.
  const byId = new Map<string, CallState>();
  const byIndex = new Map<string, CallState>();
  let latest: CallState | undefined;

  return (frame) => {
    const lines = frame.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith('data:'));
    const data = dataLines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return frame;

    let chunk: Record<string, unknown> | undefined;
    try {
      chunk = record(JSON.parse(data));
    } catch {
      return frame; // The SDK reports malformed frames itself.
    }
    if (!chunk || !Array.isArray(chunk.choices)) return frame;

    let dropped = 0;
    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice);
      const delta = record(choice?.delta);
      if (!delta || !Array.isArray(delta.tool_calls)) continue;
      const choiceIndex = typeof choice?.index === 'number' ? choice.index : 0;

      const kept = (delta.tool_calls as unknown[]).filter((rawCall) => {
        const call = record(rawCall);
        if (!call) return true;
        const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
        const indexKey = typeof call.index === 'number' ? `${choiceIndex}:${call.index}` : undefined;
        const fn = record(call.function);
        const args = typeof fn?.arguments === 'string' ? fn.arguments : '';

        let state = id !== undefined ? byId.get(id) : indexKey !== undefined ? byIndex.get(indexKey) : latest;
        if (state === undefined) {
          state = { id, arguments: args };
          if (id !== undefined) byId.set(id, state);
          if (indexKey !== undefined) byIndex.set(indexKey, state);
          latest = state;
          return true;
        }
        if (indexKey !== undefined) byIndex.set(indexKey, state);
        latest = state;
        if (state.id === undefined && id !== undefined) {
          state.id = id;
          byId.set(id, state);
        }
        if (args.length === 0) return true;
        if (isCompleteJson(state.arguments)) {
          dropped += args.length;
          delete fn!.arguments;
          // Nothing else in this fragment is news to the SDK.
          return fn!.name !== undefined && fn!.name !== null;
        }
        state.arguments += args;
        return true;
      });
      if (kept.length === 0) delete delta.tool_calls;
      else delta.tool_calls = kept;
    }

    if (dropped === 0) return frame;
    log.warn('upstream.tool_args_repeat_dropped', { chars: dropped });
    const rest = lines.filter((line) => !line.startsWith('data:'));
    return [...rest, `data: ${JSON.stringify(chunk)}`].join('\n');
  };
}

/**
 * Wraps a fetch so streamed chat-completions responses pass through
 * {@link createToolArgsGuard}. Anything else is returned untouched.
 */
export function withToolArgsGuard(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    if (
      !response.ok ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
      response.body === null
    ) {
      return response;
    }

    const guard = createToolArgsGuard();
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
          controller.enqueue(encoder.encode(guard(frame) + boundary[0]));
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
}
