#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible /v1/moderations stub for local verification.
 * Flags any input containing FLAG_TOKEN. For E2E testing only.
 *
 * Usage: node scripts/stub-moderation.mjs
 */
import { createServer } from 'node:http';

const PORT = 11436;
const FLAG_TOKEN = 'flagme';

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/moderations') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const input = String(parsed.input ?? '');
      const flagged = input.toLowerCase().includes(FLAG_TOKEN);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              flagged,
              categories: { violence: flagged, hate: false, sexual: false },
            },
          ],
        }),
      );
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Stub moderation running on http://localhost:${PORT}`);
  console.log(`POST /v1/moderations -> flags input containing "${FLAG_TOKEN}"`);
});
