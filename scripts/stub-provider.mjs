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

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
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
  console.log('POST /v1/chat/completions → returns fixture spec with real token counts');
  console.log('Add channel: provider=openai_compatible, base_url=http://localhost:11435, model_id=stub-fixture');
});
