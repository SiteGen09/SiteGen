import { chatCompletionRequestSchema, totalToolChars, chatRequestHash } from './lib/chat/request';
import { moderationText, toToolSet, toToolChoice, toModelMessages } from './lib/chat/tools';

const body = {
  model: 'stub-chat',
  messages: [{ role: 'user', content: 'read the readme' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ],
  tool_choice: 'auto',
};

const p = chatCompletionRequestSchema.safeParse(body);
console.log('parse ok?', p.success, p.success ? '' : JSON.stringify(p.error.issues, null, 2));
if (!p.success) process.exit(1);
const d = p.data;
console.log('toolChars', totalToolChars(d.tools));
console.log('hash', chatRequestHash(d));
console.log('moderation', JSON.stringify(moderationText(d.messages)));
console.log('toolset keys', JSON.stringify(Object.keys(toToolSet(d.tools) ?? {})));
console.log('toolchoice', JSON.stringify(toToolChoice(d.tool_choice)));
console.log('msgs', JSON.stringify(toModelMessages(d.messages)));
