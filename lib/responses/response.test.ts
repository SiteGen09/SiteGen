import { describe, it, expect } from 'vitest';
import type { OpenAiToolCall } from '@/lib/chat/tools';
import type { NormalizedUsage } from '@/lib/generate/usage';
import type { OpenAiErrorBody } from '@/lib/api/openai-errors';
import { responseObject, sseFrame, createResponseFrames } from './response';

describe('responseObject', () => {
  const baseParams = {
    requestId: 'test123',
    model: 'gpt-4',
    createdAt: 1700000000,
    status: 'completed' as const,
    content: '',
    toolCalls: [],
    finishReason: 'stop',
    usage: null,
  };

  it('includes exactly one message output item when content is non-empty', () => {
    const result = responseObject({
      ...baseParams,
      content: 'Hello world',
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    });

    expect(result.output).toHaveLength(1);
    const item = (result.output as Array<Record<string, unknown>>)[0];
    expect(item?.type).toBe('message');
    expect(item?.id).toBe('msg_test123');
    expect(item?.status).toBe('completed');
    expect(item?.role).toBe('assistant');
    expect(item?.content).toEqual([
      {
        type: 'output_text',
        text: 'Hello world',
        annotations: [],
      },
    ]);
    expect(result.output_text).toBe('Hello world');
  });

  it('omits the message item when content is empty and includes function_call items', () => {
    const toolCalls: OpenAiToolCall[] = [
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"SF"}' },
      },
      {
        id: 'call_def',
        type: 'function',
        function: { name: 'get_time', arguments: '{}' },
      },
    ];

    const result = responseObject({
      ...baseParams,
      content: '',
      toolCalls,
      usage: { inputTokens: 20, outputTokens: 30, cachedTokens: 5 },
    });

    expect(result.output).toHaveLength(2);
    const items = result.output as Array<Record<string, unknown>>;
    expect(items[0]?.type).toBe('function_call');
    expect(items[0]?.id).toBe('fc_call_abc');
    expect(items[0]?.call_id).toBe('call_abc');
    expect(items[0]?.name).toBe('get_weather');
    expect(items[0]?.arguments).toBe('{"city":"SF"}');
    expect(items[0]?.status).toBe('completed');

    expect(items[1]?.type).toBe('function_call');
    expect(items[1]?.id).toBe('fc_call_def');
    expect(items[1]?.call_id).toBe('call_def');
    expect(items[1]?.name).toBe('get_time');
    expect(items[1]?.arguments).toBe('{}');
    expect(items[1]?.status).toBe('completed');

    expect(result.output_text).toBe('');
  });

  it('computes usage arithmetic including cached tokens', () => {
    const usage: NormalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 25,
    };

    const result = responseObject({
      ...baseParams,
      content: 'test',
      usage,
    });

    const resultUsage = result.usage as Record<string, unknown>;
    expect(resultUsage.input_tokens).toBe(125); // inputTokens + cachedTokens
    expect(resultUsage.output_tokens).toBe(50);
    expect(resultUsage.total_tokens).toBe(175); // 125 + 50
    expect(resultUsage.input_tokens_details).toEqual({ cached_tokens: 25 });
    expect(resultUsage.output_tokens_details).toEqual({ reasoning_tokens: 0 });
  });

  it('yields status incomplete and incomplete_details when finishReason maps to length', () => {
    const result = responseObject({
      ...baseParams,
      content: 'truncated',
      finishReason: 'length',
      status: 'incomplete',
      usage: { inputTokens: 10, outputTokens: 100, cachedTokens: 0 },
    });

    expect(result.status).toBe('incomplete');
    expect(result.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('yields null incomplete_details when finishReason is not length', () => {
    const result = responseObject({
      ...baseParams,
      content: 'done',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    });

    expect(result.status).toBe('completed');
    expect(result.incomplete_details).toBeNull();
  });

  it('produces an in-progress object with empty output and null usage', () => {
    const result = responseObject({
      ...baseParams,
      status: 'in_progress',
      content: '',
      toolCalls: [],
      finishReason: null,
      usage: null,
    });

    expect(result.status).toBe('in_progress');
    expect(result.output).toEqual([]);
    expect(result.output_text).toBe('');
    expect(result.usage).toBeNull();
    expect(result.incomplete_details).toBeNull();
  });

  it('echoes the public model name', () => {
    const result = responseObject({
      ...baseParams,
      model: 'gpt-4-turbo',
      usage: { inputTokens: 5, outputTokens: 3, cachedTokens: 0 },
    });

    expect(result.model).toBe('gpt-4-turbo');
  });

  it('includes the response id with resp_ prefix', () => {
    const result = responseObject({
      ...baseParams,
      requestId: 'xyz789',
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    expect(result.id).toBe('resp_xyz789');
  });

  it('includes inert fields for SDK destructuring', () => {
    const result = responseObject({
      ...baseParams,
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });

    expect(result.error).toBeNull();
    expect(result.instructions).toBeNull();
    expect(result.metadata).toEqual({});
    expect(result.parallel_tool_calls).toBe(true);
    expect(result.tool_choice).toBe('auto');
    expect(result.tools).toEqual([]);
  });
});

describe('sseFrame', () => {
  it('emits both event and data lines and terminates with a blank line', () => {
    const frame = sseFrame('test.event', { type: 'test', value: 42 });

    expect(frame).toBe('event: test.event\ndata: {"type":"test","value":42}\n\n');
  });

  it('includes the event line for client routing', () => {
    const frame = sseFrame('response.created', { sequence_number: 0 });

    expect(frame).toContain('event: response.created\n');
    expect(frame).toContain('data: {"sequence_number":0}\n');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});

describe('createResponseFrames', () => {
  it('increments sequence_number across successive frames', () => {
    const frames = createResponseFrames({
      requestId: 'seq123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    const created = frames.created();
    expect(created).toContain('"sequence_number":0');

    const delta1 = frames.textDelta('hello');
    expect(delta1).toContain('"sequence_number":1');

    const delta2 = frames.textDelta(' world');
    expect(delta2).toContain('"sequence_number":2');

    const added = frames.functionCallAdded(0, 'call_x', 'test_fn');
    expect(added).toContain('"sequence_number":3');

    const argsDelta = frames.functionCallArgumentsDelta(0, 'call_x', '{"a');
    expect(argsDelta).toContain('"sequence_number":4');

    const done = frames.functionCallDone(0, 'call_x', 'test_fn', '{"a":1}');
    expect(done).toContain('"sequence_number":5');

    const completed = frames.completed({
      content: 'hello world',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    });
    expect(completed).toContain('"sequence_number":6');
  });

  it('echoes the public model name in created and completed frames', () => {
    const frames = createResponseFrames({
      requestId: 'model123',
      model: 'gpt-4-turbo',
      createdAt: 1700000000,
    });

    const created = frames.created();
    expect(created).toContain('"model":"gpt-4-turbo"');

    const completed = frames.completed({
      content: 'done',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });
    expect(completed).toContain('"model":"gpt-4-turbo"');
  });

  it('created emits response.created event with in_progress status', () => {
    const frames = createResponseFrames({
      requestId: 'create123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    const frame = frames.created();

    expect(frame).toContain('event: response.created\n');
    expect(frame).toContain('"type":"response.created"');
    expect(frame).toContain('"status":"in_progress"');
    expect(frame).toContain('"output":[]');
    expect(frame).toContain('"usage":null');
  });

  it('textDelta emits response.output_text.delta event', () => {
    const frames = createResponseFrames({
      requestId: 'delta123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created(); // advance sequence
    const frame = frames.textDelta('test text');

    expect(frame).toContain('event: response.output_text.delta\n');
    expect(frame).toContain('"type":"response.output_text.delta"');
    expect(frame).toContain('"item_id":"msg_delta123"');
    expect(frame).toContain('"output_index":0');
    expect(frame).toContain('"content_index":0');
    expect(frame).toContain('"delta":"test text"');
  });

  it('functionCallAdded emits response.output_item.added with in_progress status', () => {
    const frames = createResponseFrames({
      requestId: 'add123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const frame = frames.functionCallAdded(0, 'call_abc', 'get_weather');

    expect(frame).toContain('event: response.output_item.added\n');
    expect(frame).toContain('"type":"response.output_item.added"');
    expect(frame).toContain('"output_index":1'); // index + 1
    expect(frame).toContain('"id":"fc_call_abc"');
    expect(frame).toContain('"call_id":"call_abc"');
    expect(frame).toContain('"name":"get_weather"');
    expect(frame).toContain('"arguments":""');
    expect(frame).toContain('"status":"in_progress"');
  });

  it('functionCallArgumentsDelta emits response.function_call_arguments.delta', () => {
    const frames = createResponseFrames({
      requestId: 'args123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const frame = frames.functionCallArgumentsDelta(0, 'call_xyz', '{"city"');

    expect(frame).toContain('event: response.function_call_arguments.delta\n');
    expect(frame).toContain('"type":"response.function_call_arguments.delta"');
    expect(frame).toContain('"item_id":"fc_call_xyz"');
    expect(frame).toContain('"output_index":1');
    expect(frame).toContain('"delta":"{\\"city\\""');
  });

  it('functionCallDone emits response.output_item.done with completed status', () => {
    const frames = createResponseFrames({
      requestId: 'done123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const frame = frames.functionCallDone(0, 'call_done', 'test_fn', '{"result":true}');

    expect(frame).toContain('event: response.output_item.done\n');
    expect(frame).toContain('"type":"response.output_item.done"');
    expect(frame).toContain('"output_index":1');
    expect(frame).toContain('"id":"fc_call_done"');
    expect(frame).toContain('"call_id":"call_done"');
    expect(frame).toContain('"name":"test_fn"');
    expect(frame).toContain('"arguments":"{\\"result\\":true}"');
    expect(frame).toContain('"status":"completed"');
  });

  it('completed emits response.completed with final usage and status', () => {
    const frames = createResponseFrames({
      requestId: 'complete123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const frame = frames.completed({
      content: 'final result',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 50, outputTokens: 25, cachedTokens: 10 },
    });

    expect(frame).toContain('event: response.completed\n');
    expect(frame).toContain('"type":"response.completed"');
    expect(frame).toContain('"status":"completed"');
    expect(frame).toContain('"output_text":"final result"');
    expect(frame).toContain('"input_tokens":60'); // 50 + 10
    expect(frame).toContain('"output_tokens":25');
    expect(frame).toContain('"cached_tokens":10');
  });

  it('completed yields incomplete status when finishReason is length', () => {
    const frames = createResponseFrames({
      requestId: 'incomplete123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const frame = frames.completed({
      content: 'cut off',
      toolCalls: [],
      finishReason: 'length',
      usage: { inputTokens: 10, outputTokens: 100, cachedTokens: 0 },
    });

    expect(frame).toContain('"status":"incomplete"');
    expect(frame).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
  });

  it('failed emits error event with sequence_number and spreads OpenAiErrorBody', () => {
    const frames = createResponseFrames({
      requestId: 'fail123',
      model: 'gpt-4',
      createdAt: 1700000000,
    });

    frames.created();
    const errorBody: OpenAiErrorBody = {
      error: {
        message: 'upstream timeout',
        type: 'api_error',
        param: null,
        code: 'internal_error',
        request_id: 'fail123',
      },
    };

    const frame = frames.failed(errorBody);

    expect(frame).toContain('event: error\n');
    expect(frame).toContain('"type":"error"');
    expect(frame).toContain('"sequence_number":1');
    expect(frame).toContain('"message":"upstream timeout"');
    expect(frame).toContain('"code":"internal_error"');
  });
});
