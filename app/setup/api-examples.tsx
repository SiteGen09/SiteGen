'use client';

import { useState } from 'react';
import { CopyButton } from './copy-button';
import { KEY_PLACEHOLDER } from './shared';

const TAB_ORDER = ['cURL', 'Python', 'JavaScript', 'Claude Messages'] as const;

type Tab = (typeof TAB_ORDER)[number];

export function ApiExamples({
  openaiBase,
  anthropicBase,
  model,
  anthropicModel,
}: {
  openaiBase: string;
  anthropicBase: string;
  model: string;
  anthropicModel: string;
}) {
  const [tab, setTab] = useState<Tab>('cURL');

  const samples: Record<Tab, string> = {
    cURL: [
      `curl ${openaiBase}/chat/completions \\`,
      `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\`,
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      `    "model": "${model}",`,
      '    "messages": [{"role": "user", "content": "Reply with OK"}]',
      "  }'",
    ].join('\n'),
    Python: [
      'from openai import OpenAI',
      '',
      'client = OpenAI(',
      `    base_url="${openaiBase}",`,
      `    api_key="${KEY_PLACEHOLDER}",`,
      ')',
      '',
      'response = client.chat.completions.create(',
      `    model="${model}",`,
      '    messages=[{"role": "user", "content": "Reply with OK"}],',
      ')',
      'print(response.choices[0].message.content)',
    ].join('\n'),
    JavaScript: [
      "import OpenAI from 'openai';",
      '',
      'const client = new OpenAI({',
      `  baseURL: '${openaiBase}',`,
      `  apiKey: '${KEY_PLACEHOLDER}',`,
      '});',
      '',
      'const response = await client.chat.completions.create({',
      `  model: '${model}',`,
      "  messages: [{ role: 'user', content: 'Reply with OK' }],",
      '});',
      'console.log(response.choices[0].message.content);',
    ].join('\n'),
    'Claude Messages': [
      `curl ${anthropicBase}/v1/messages \\`,
      `  -H "x-api-key: ${KEY_PLACEHOLDER}" \\`,
      '  -H "anthropic-version: 2023-06-01" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{",
      `    "model": "${anthropicModel}",`,
      '    "max_tokens": 32,',
      '    "messages": [{"role": "user", "content": "Reply with OK"}]',
      "  }'",
    ].join('\n'),
  };

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-zinc-900">API call examples</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">
        Use the OpenAI-compatible endpoint for GPT apps and the Anthropic-compatible endpoint for
        Claude Code or Claude Desktop. Both formats route over the same channels and bill
        identically, so the choice is about what your client speaks, not what the model runs on.
      </p>
      <div className="mt-4 rounded-xl border border-zinc-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2">
          <div role="tablist" aria-label="Language" className="flex flex-wrap gap-1">
            {TAB_ORDER.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={
                  tab === name
                    ? 'min-h-8 rounded-md border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900'
                    : 'min-h-8 rounded-md border border-transparent px-2.5 py-1 text-xs font-medium text-zinc-600 hover:text-zinc-900'
                }
              >
                {name}
              </button>
            ))}
          </div>
          <CopyButton value={samples[tab]} />
        </div>
        <pre className="overflow-x-auto px-4 py-4 text-xs leading-relaxed text-zinc-800">
          {samples[tab]}
        </pre>
      </div>
    </section>
  );
}
