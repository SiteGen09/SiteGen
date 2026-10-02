import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/lib/chat/request';
import { detectLoop, loopReminder, toolHistory } from './loops';

let seq = 0;
/** One agent step: an assistant tool call and the caller's answer to it. */
function step(name: string, args: Record<string, unknown>, result: string): ChatMessage[] {
  const id = `call_${(seq += 1)}`;
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

const start: ChatMessage[] = [{ role: 'user', content: 'Fix the failing build.' }];

describe('detectLoop', () => {
  it('detects quoting failures with changed arguments and an intervening read', () => {
    const messages = [
      ...step('Bash', { command: "cat > a.ts <<'EOF'" }, "bash: unexpected EOF while looking for matching quote"),
      ...step('Read', { file: 'a.ts' }, 'source'),
      ...step('Bash', { command: "cat > b.ts <<'EOF'" }, "bash: unexpected EOF while looking for matching quote"),
    ];
    const signal = detectLoop(toolHistory(messages));
    expect(signal).toEqual({ kind: 'recurring-failure', tool: 'Bash', count: 2, failure: 'shell-quoting' });
    expect(loopReminder(signal!)).toContain('available file edit tool');
  });

  it('detects stale edits while avoiding successful reads of error fixtures', () => {
    const messages = [
      ...step('Edit', { old_string: 'one' }, '<tool_use_error>String to replace not found in file.</tool_use_error>'),
      ...step('Read', { file: 'x' }, 'current text'),
      ...step('Edit', { old_string: 'two' }, '<tool_use_error>String to replace not found in file.</tool_use_error>'),
    ];
    expect(detectLoop(toolHistory(messages))).toMatchObject({ kind: 'recurring-failure', failure: 'edit-context' });
    expect(detectLoop(toolHistory([
      ...step('Read', { file: 'fixture1' }, "unexpected EOF while looking for matching quote"),
      ...step('Read', { file: 'fixture2' }, "unexpected EOF while looking for matching quote"),
    ]))).toBeNull();
  });

  it('clears recurring failures after the same tool succeeds', () => {
    const messages = [
      ...step('Edit', { old_string: 'one' }, '<tool_use_error>String to replace not found</tool_use_error>'),
      ...step('Edit', { old_string: 'two' }, 'File updated successfully'),
      ...step('Edit', { old_string: 'three' }, '<tool_use_error>String to replace not found</tool_use_error>'),
    ];
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('keeps failed writes visible across successful shell inspections but resets on a write', () => {
    const error = "Exit code 2\nbash: unexpected EOF while looking for matching quote";
    const first = step('Bash', { command: "cat > a.ts <<'EOF'" }, error);
    const second = step('Bash', { command: "cat > b.ts <<'EOF'" }, error);
    expect(detectLoop(toolHistory([
      ...first,
      ...step('Bash', { command: "sed -n '1,110p' server/domain.ts; cat shared/review.ts" }, 'source'),
      ...step('Bash', { command: 'pwd; ls src; wc -l server/domain.ts' }, '/workspace'),
      ...step('Bash', { command: 'ls -a ..; curl -L --max-time 20 -s https://example.com/docs | head -c 2500' }, 'documentation'),
      ...second,
    ]))).toMatchObject({ kind: 'recurring-failure', count: 2 });
    expect(detectLoop(toolHistory([
      ...first,
      ...step('Bash', { command: 'cat > a.ts' }, 'File written'),
      ...second,
    ]))).toBeNull();
  });

  it('does not diagnose an old failure while the latest tool is still pending', () => {
    const messages = Array.from({ length: 3 }, () => step('Bash', { cmd: 'x' }, 'Error: boom')).flat();
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'pending', function: { name: 'Bash', arguments: '{}' } }] });
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('stays quiet for an agent making progress', () => {
    const messages = [
      ...start,
      ...step('Read', { file: 'a.ts' }, 'contents of a'),
      ...step('Edit', { file: 'a.ts', patch: 1 }, 'ok'),
      ...step('Bash', { cmd: 'pnpm build' }, 'Build succeeded'),
    ];
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('flags the same call answered the same way three times, whatever the key order', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'pnpm test', cwd: '/app' }, '3 tests failed'),
      ...step('Read', { file: 'a.ts' }, 'contents'),
      ...step('Bash', { cwd: '/app', cmd: 'pnpm test' }, '3 tests failed'),
      ...step('Bash', { cmd: 'pnpm test', cwd: '/app' }, '3 tests failed'),
    ];
    expect(detectLoop(toolHistory(messages))).toEqual({ kind: 'repeat', tool: 'Bash', count: 3 });
  });

  it('does not count a repeat whose result changed: that is progress', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'pnpm test' }, '3 tests failed'),
      ...step('Bash', { cmd: 'pnpm test' }, '2 tests failed'),
      ...step('Bash', { cmd: 'pnpm test' }, '1 test failed'),
    ];
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('flags a streak of failures in different shapes', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'npm i' }, 'Error: EACCES: permission denied'),
      ...step('Bash', { cmd: 'sudo npm i' }, 'bash: sudo: command not found\nexit code 127'),
      ...step('Edit', { file: 'x' }, '<tool_use_error>File has not been read yet</tool_use_error>'),
      ...step('Bash', { cmd: 'python setup.py' }, 'Traceback (most recent call last):\n  ...'),
    ];
    expect(detectLoop(toolHistory(messages))).toEqual({ kind: 'failures', tool: 'Bash', count: 4 });
  });

  it('recognizes structured failures and failure summaries at the end of long logs', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'build' }, JSON.stringify({ stdout: 'Compiling', exit_code: 1 })),
      ...step('Bash', { cmd: 'typecheck' }, JSON.stringify({ execution: { exitCode: 2 } })),
      ...step('Edit', { file: 'x' }, JSON.stringify({ isError: true, content: 'Could not edit' })),
      ...step('Bash', { cmd: 'test' }, `${'Passing tests\n'.repeat(300)}3 tests failed`),
    ];
    expect(detectLoop(toolHistory(messages))).toEqual({ kind: 'failures', tool: 'Bash', count: 4 });
  });

  it('does not treat a successful structured result containing error text as a failure', () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      step('Bash', { cmd: `inspect ${index}` }, JSON.stringify({ exit_code: 0, stdout: 'The source contains Error: as data' }))).flat();
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('does not mistake files and passing runs that mention errors for failures', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'pnpm test' }, 'Test Files  3 passed\nTests  42 passed, 0 tests failed'),
      ...step('Read', { file: 'mock.json' }, JSON.stringify({ responses: { notFound: { status: 'error', error: 'Not found' } } })),
      ...step('Read', { file: 'errors.ts' }, `${'export const ok = 1;\n'.repeat(200)}throw new Error('permission denied');`),
      ...step('Read', { file: 'fs.ts' }, "// Handles files\nif (code === 'ENOENT') return 'no such file or directory';"),
    ];
    expect(toolHistory(messages).map((record) => record.failed)).toEqual([false, false, false, false]);
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('forgets a loop the agent already broke out of', () => {
    const messages = [
      ...start,
      ...step('Bash', { cmd: 'x' }, 'Error: boom'),
      ...step('Bash', { cmd: 'y' }, 'Error: boom'),
      ...step('Bash', { cmd: 'z' }, 'Error: boom'),
      ...step('Bash', { cmd: 'w' }, 'Error: boom'),
      ...step('Read', { file: 'README.md' }, 'readme'),
    ];
    expect(detectLoop(toolHistory(messages))).toBeNull();
  });

  it('writes a reminder that names the tool and tells the model to change course', () => {
    expect(loopReminder({ kind: 'repeat', tool: 'Bash', count: 3 })).toMatch(/`Bash`.*3 times.*change approach/s);
    expect(loopReminder({ kind: 'failures', tool: 'Bash', count: 4 })).toMatch(/last 4 tool calls all failed/);
  });
});
