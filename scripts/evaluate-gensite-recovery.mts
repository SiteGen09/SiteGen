/** Offline diagnostics only: never executes a trace's tools or sends API requests. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { messagesRequestSchema, toChatMessages } from '../lib/messages/request';
import { detectLoop, toolHistory } from '../lib/gensite/loops';
import type { ChatMessage } from '../lib/chat/request';

const args = process.argv.slice(2);
if (args.length !== 1 && !(args.length === 3 && args[1] === '--out')) {
  console.error('Usage: pnpm exec tsx scripts/evaluate-gensite-recovery.mts <claude-stream.jsonl> [--out <report.json>]');
  process.exit(1);
}
const trace = resolve(args[0]!);
const raw = readFileSync(trace, 'utf8');
if (Buffer.byteLength(raw) > 25_000_000) throw new Error('Trace exceeds the 25 MB replay limit.');
const lines = raw.split(/\r?\n/).filter(Boolean);
if (lines.length > 10_000) throw new Error('Trace exceeds the 10,000 event replay limit.');
const history: ChatMessage[] = [];
const signals: Array<{ event: number; kind: string; tool: string; count: number; failure?: string }> = [];
let skipped = 0;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
for (const [index, line] of lines.entries()) {
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(line)); } catch { skipped += 1; continue; }
  if (event.type !== 'assistant' && event.type !== 'user') continue;
  const message = record(event.message);
  if (message.role !== 'assistant' && message.role !== 'user') { skipped += 1; continue; }
  // Claude traces also contain thinking blocks and transport metadata; neither
  // belongs to the normalized text/tool history used by this diagnostic.
  const content = Array.isArray(message.content)
    ? message.content.filter((block: unknown) => ['text', 'tool_use', 'tool_result'].includes(String(record(block).type)))
    : message.content;
  const parsed = messagesRequestSchema.safeParse({ model: 'gensite-v1', max_tokens: 1, messages: [{ role: message.role, content }] });
  if (!parsed.success) { skipped += 1; continue; }
  const converted = toChatMessages(parsed.data);
  history.push(...converted);
  if (!converted.some(message => message.role === 'tool')) continue;
  const signal = detectLoop(toolHistory(history));
  if (signal) signals.push({ event: index + 1, ...signal });
}
const records = toolHistory(history);
const report = {
  mode: 'offline-observed-history', events: lines.length, skipped,
  toolCalls: records.length, answered: records.filter(record => record.result !== null).length,
  failures: records.filter(record => record.failed).length, signals,
  limitation: 'Signals show when guidance would be issued. They do not establish that the model repaired the failure or completed the task.',
};
const output = JSON.stringify(report, null, 2) + '\n';
if (args[2]) {
  const destination = resolve(args[2]);
  if (destination.toLowerCase() === trace.toLowerCase()) throw new Error('Output must not overwrite the input trace.');
  writeFileSync(destination, output, { flag: 'wx' });
}
process.stdout.write(output);
