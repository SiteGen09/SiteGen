#!/usr/bin/env node
/**
 * Minimal HTTP stub that returns OpenAI-compatible chat completions
 * with fixture site specs. For E2E testing only.
 * 
 * Usage: node scripts/stub-provider.mjs
 * Runs on http://localhost:11435
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = 11435;
const FIXTURES_DIR = join(process.cwd(), 'fixtures', 'specs');

const fixtures = {
  restaurant: JSON.parse(readFileSync(join(FIXTURES_DIR, 'restaurant.json'), 'utf-8')),
  portfolio: JSON.parse(readFileSync(join(FIXTURES_DIR, 'portfolio.json'), 'utf-8')),
  saas: JSON.parse(readFileSync(join(FIXTURES_DIR, 'saas.json'), 'utf-8')),
};

function pickFixture(body) {
  const text = JSON.stringify(body).toLowerCase();
  if (text.includes('portfolio') || text.includes('designer')) return fixtures.portfolio;
  if (text.includes('saas') || text.includes('software')) return fixtures.saas;
  return fixtures.restaurant;
}

// Arguments are deliberately fixed and need not satisfy the caller's JSON
// Schema: the gateway must forward them verbatim, never validate or execute.
const TOOL_CALL_ID = 'call_stub_1';
const TOOL_CALL_ARGUMENTS = JSON.stringify({ path: 'README.md' });
const TOOL_USAGE = { prompt_tokens: 180, completion_tokens: 24, total_tokens: 204 };

function toolCallEnvelope() {
  return {
    id: `chatcmpl-stub-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'stub-fixture',
  };
}

function respondWithToolCall(res, parsed, name) {
  const envelope = toolCallEnvelope();
  const call = { id: TOOL_CALL_ID, type: 'function', function: { name, arguments: TOOL_CALL_ARGUMENTS } };

  if (parsed.stream === true) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const base = { ...envelope, object: 'chat.completion.chunk' };
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    send({
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name, arguments: '' } }] },
          finish_reason: null,
        },
      ],
    });
    // Split across several fragments: a single-fragment stream would not prove
    // the gateway reassembles argument deltas.
    const size = Math.max(1, Math.ceil(TOOL_CALL_ARGUMENTS.length / 3));
    for (let at = 0; at < TOOL_CALL_ARGUMENTS.length; at += size) {
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: TOOL_CALL_ARGUMENTS.slice(at, at + size) } }] },
            finish_reason: null,
          },
        ],
      });
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: TOOL_USAGE });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...envelope,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [call] },
      finish_reason: 'tool_calls',
    }],
    usage: TOOL_USAGE,
  }));
}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);

        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        if (tools.length > 0) {
          const name = tools[0]?.function?.name;
          respondWithToolCall(res, parsed, typeof name === 'string' && name ? name : 'stub_tool');
          return;
        }
        const spec = pickFixture(parsed);
        
        // OpenAI chat completions format with realistic token counts
        const response = {
          id: `chatcmpl-stub-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'stub-fixture',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify(spec),
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 1420,
            completion_tokens: 2890,
            total_tokens: 4310,
          },
        };

        if (parsed.stream === true) {
          // OpenAI-shaped SSE, so the gateway's streaming path can be
          // exercised without a live provider. Content is split into a few
          // deltas because a single-chunk stream would not prove much.
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const base = {
            id: response.id,
            object: 'chat.completion.chunk',
            created: response.created,
            model: 'stub-fixture',
          };
          send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          const text = response.choices[0].message.content;
          const size = Math.max(1, Math.ceil(text.length / 4));
          for (let at = 0; at < text.length; at += size) {
            send({
              ...base,
              choices: [
                { index: 0, delta: { content: text.slice(at, at + size) }, finish_reason: null },
              ],
            });
          }
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: response.usage });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
  }
});

server.listen(PORT, () => {
  console.log(`Stub provider running on http://localhost:${PORT}`);
  console.log('POST /v1/chat/completions → fixture spec; `stream: true` returns SSE');
  console.log('A request carrying a non-empty `tools` array returns a tool call instead (buffered or SSE)');
  console.log('Add channel: provider=openai_compatible, base_url=http://localhost:11435, model_id=stub-fixture');
});
