import { describe, expect, it } from 'vitest';

import { createToolArgsGuard, withToolArgsGuard } from './tool-args-guard';

function frame(toolCalls: unknown[]): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] })}`;
}

function toolCallsOf(output: string): unknown {
  return JSON.parse(output.slice('data: '.length)).choices[0].delta.tool_calls;
}

describe('createToolArgsGuard', () => {
  it('drops a whole-arguments repeat after the call already parsed', () => {
    const guard = createToolArgsGuard();
    guard(frame([{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '' } }]));
    guard(frame([{ index: 0, function: { arguments: '{"cmd":' } }]));
    guard(frame([{ index: 0, function: { arguments: '"ls"}' } }]));

    const repeat = guard(frame([{ index: 0, function: { arguments: '{"cmd":"ls"}' } }]));
    expect(toolCallsOf(repeat)).toBeUndefined();

    const namedRepeat = guard(frame([{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }]));
    expect(toolCallsOf(namedRepeat)).toEqual([{ index: 0, id: 'call_1', function: { name: 'exec_command' } }]);
  });

  it('passes fragments through until the arguments are complete', () => {
    const guard = createToolArgsGuard();
    const parts = ['{"cmd":"echo }', '{"', '}"', '}'];
    const first = frame([{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '' } }]);
    expect(guard(first)).toBe(first);
    for (const part of parts) {
      const input = frame([{ index: 0, function: { arguments: part } }]);
      expect(guard(input)).toBe(input);
    }
  });

  it('keeps parallel calls and a new id on a reused index', () => {
    const guard = createToolArgsGuard();
    guard(frame([{ index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } }]));
    const second = frame([{ index: 1, id: 'call_2', function: { name: 'b', arguments: '{}' } }]);
    expect(guard(second)).toBe(second);
    const reused = frame([{ index: 0, id: 'call_3', function: { name: 'c', arguments: '{}' } }]);
    expect(guard(reused)).toBe(reused);
  });

  it('leaves non-tool frames and [DONE] untouched', () => {
    const guard = createToolArgsGuard();
    const text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}`;
    expect(guard(text)).toBe(text);
    expect(guard('data: [DONE]')).toBe('data: [DONE]');
  });
});

describe('withToolArgsGuard', () => {
  it('rewrites a streamed repeat end to end', async () => {
    const sse = [
      frame([{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }]),
      frame([{ index: 0, function: { arguments: '{"cmd":"ls"}' } }]),
      'data: [DONE]',
    ].join('\n\n') + '\n\n';
    const guarded = withToolArgsGuard(async () =>
      new Response(sse, { headers: { 'content-type': 'text/event-stream' } }));

    const body = await (await guarded('https://relay.example/v1/chat/completions')).text();
    const args = body.split('\n\n')
      .filter((f) => f.startsWith('data: {'))
      .flatMap((f) => (toolCallsOf(f) as { function?: { arguments?: string } }[] | undefined) ?? [])
      .map((call) => call.function?.arguments ?? '')
      .join('');
    expect(args).toBe('{"cmd":"ls"}');
  });
});
