import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatTool } from './request';
import {
  moderationText,
  openAiFinishReason,
  toModelMessages,
  toOpenAiToolCalls,
  toToolChoice,
  toToolSet,
} from './tools';

function toolDefinition(name: string, description?: string): ChatTool {
  return {
    type: 'function',
    function: {
      name,
      ...(description === undefined ? {} : { description }),
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    },
  };
}

describe('toToolSet', () => {
  it('returns undefined for undefined and for an empty array', () => {
    expect(toToolSet(undefined)).toBeUndefined();
    expect(toToolSet([])).toBeUndefined();
  });

  it('produces one entry per declared tool, keyed by name', () => {
    const toolSet = toToolSet([toolDefinition('get_weather'), toolDefinition('get_time')]);
    expect(Object.keys(toolSet ?? {})).toEqual(['get_weather', 'get_time']);
  });

  it('never attaches an execute function, so the SDK hands the call back', () => {
    const toolSet = toToolSet([toolDefinition('get_weather')]);
    const entry = toolSet?.['get_weather'];
    expect(entry).toBeDefined();
    expect(entry?.execute).toBeUndefined();
  });

  it('carries the description and the client JSON Schema through', async () => {
    const toolSet = toToolSet([toolDefinition('get_weather', 'Look up the weather')]);
    const entry = toolSet?.['get_weather'];
    expect(entry?.description).toBe('Look up the weather');
    expect(await asSchema(entry?.inputSchema).jsonSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
  });

  it('defaults a missing parameters schema to an empty object schema', async () => {
    const toolSet = toToolSet([{ type: 'function', function: { name: 'ping' } }]);
    expect(await asSchema(toolSet?.['ping']?.inputSchema).jsonSchema).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('lets the last duplicate name win, matching OpenAI', async () => {
    const toolSet = toToolSet([
      toolDefinition('get_weather', 'first'),
      toolDefinition('get_weather', 'second'),
    ]);
    expect(Object.keys(toolSet ?? {})).toEqual(['get_weather']);
    expect(toolSet?.['get_weather']?.description).toBe('second');
  });
});

describe('toToolChoice', () => {
  it('passes the string forms through', () => {
    expect(toToolChoice('auto')).toBe('auto');
    expect(toToolChoice('none')).toBe('none');
    expect(toToolChoice('required')).toBe('required');
  });

  it('maps a named function choice to the SDK tool form', () => {
    expect(toToolChoice({ type: 'function', function: { name: 'get_weather' } })).toEqual({
      type: 'tool',
      toolName: 'get_weather',
    });
  });

  it('returns undefined when no choice was sent', () => {
    expect(toToolChoice(undefined)).toBeUndefined();
  });
});

describe('toModelMessages', () => {
  it('converts system and user turns to plain text', () => {
    expect(
      toModelMessages([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
      ]),
    ).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
    ]);
  });

  it('converts an assistant turn that is only tool calls', () => {
    expect(
      toModelMessages([
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'Oslo' },
          },
        ],
      },
    ]);
  });

  it('keeps text alongside tool calls when the assistant sent both', () => {
    const [converted] = toModelMessages([
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
    ]);
    expect(converted).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: {} },
      ],
    });
  });

  it('falls back to an empty input when the arguments are not valid JSON', () => {
    const [converted] = toModelMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{oops' } },
        ],
      },
    ]);
    expect(converted).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: {} },
      ],
    });
  });

  it('converts a tool result into a tool-result part', () => {
    expect(
      toModelMessages([
        { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"tempC":11}' },
      ]),
    ).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            output: { type: 'text', value: '{"tempC":11}' },
          },
        ],
      },
    ]);
  });

  it('converts an assistant turn without tool calls to plain text', () => {
    expect(toModelMessages([{ role: 'assistant', content: 'done' }])).toEqual([
      { role: 'assistant', content: 'done' },
    ]);
  });
});

describe('moderationText', () => {
  it('includes tool call arguments and tool results without throwing on null content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'weather in Oslo?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"tempC":11}' },
    ];
    expect(moderationText(messages)).toBe(
      ['weather in Oslo?', 'get_weather', '{"city":"Oslo"}', '{"tempC":11}'].join('\n'),
    );
  });

  it('returns an empty string for a message with no content at all', () => {
    expect(
      moderationText([
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', function: { name: '', arguments: '' } }],
        },
      ]),
    ).toBe('\n');
  });
});

describe('openAiFinishReason', () => {
  it('maps the hyphenated SDK reasons to OpenAI names', () => {
    expect(openAiFinishReason('tool-calls')).toBe('tool_calls');
    expect(openAiFinishReason('content-filter')).toBe('content_filter');
  });

  it('passes every other reason through unchanged', () => {
    expect(openAiFinishReason('stop')).toBe('stop');
    expect(openAiFinishReason('length')).toBe('length');
    expect(openAiFinishReason('error')).toBe('error');
  });
});

describe('toOpenAiToolCalls', () => {
  it('serializes the SDK input into OpenAI arguments', () => {
    expect(
      toOpenAiToolCalls([
        { toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Oslo' } },
      ]),
    ).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
      },
    ]);
  });

  it('serializes a missing input as an empty object', () => {
    expect(
      toOpenAiToolCalls([{ toolCallId: 'call_1', toolName: 'ping', input: undefined }]),
    ).toEqual([{ id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{}' } }]);
  });
});
