'use client';

import { useMemo, useState } from 'react';
import { CopyButton } from './copy-button';
import { KEY_PLACEHOLDER, type OsKey } from './shared';

const OS_OPTIONS: { value: OsKey; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
];

/**
 * Which wire format the application speaks. It decides the base URL we hand
 * out: an OpenAI-compatible client appends `/chat/completions` to whatever it
 * is given, so it needs the `/v1` suffix, while the Anthropic SDKs append the
 * whole `/v1/messages` path and must be handed the bare origin.
 */
type Protocol = 'openai' | 'anthropic' | 'universal' | 'managed';

interface Ctx {
  openaiBase: string;
  anthropicBase: string;
  model: string;
  os: OsKey;
}

interface Step {
  text: string;
  code?: string;
}

interface AppDef {
  id: string;
  name: string;
  protocol: Protocol;
  steps: (ctx: Ctx) => Step[];
}

/** setx persists, but only for shells started afterwards, hence the note. */
function exportEnv(os: OsKey, vars: [string, string][]): string {
  if (os === 'windows') {
    return vars.map(([key, value]) => `setx ${key} "${value}"`).join('\n');
  }
  return vars.map(([key, value]) => `export ${key}="${value}"`).join('\n');
}

function envNote(os: OsKey): string {
  if (os === 'windows') {
    return 'Run these in PowerShell, then open a new terminal - setx only reaches shells started afterwards.';
  }
  const file = os === 'macos' ? '~/.zshrc' : '~/.bashrc';
  return `Add these to ${file} so they survive a new terminal, then run source ${file}.`;
}

function configPath(os: OsKey, relative: string): string {
  return os === 'windows' ? `%USERPROFILE%\\${relative.replace(/\//g, '\\')}` : `~/${relative}`;
}

// A non-empty tuple, so the `APPS[0]` fallback below is a definite AppDef.
const APPS: [AppDef, ...AppDef[]] = [
  {
    id: 'claude-code',
    name: 'Claude Code (CLI / IDE)',
    protocol: 'anthropic',
    steps: ({ anthropicBase, model, os }) => [
      { text: 'Make sure Claude Code is already installed on this computer.' },
      {
        text: `Point it at this gateway with three environment variables. ${envNote(os)}`,
        code: exportEnv(os, [
          ['ANTHROPIC_BASE_URL', anthropicBase],
          ['ANTHROPIC_AUTH_TOKEN', KEY_PLACEHOLDER],
          ['ANTHROPIC_MODEL', model],
        ]),
      },
      {
        text: 'ANTHROPIC_AUTH_TOKEN is the variable to set, not ANTHROPIC_API_KEY: the gateway reads it as a bearer token.',
      },
      { text: 'Open a new terminal, run claude, and send a test prompt.' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'openai',
    steps: ({ openaiBase, model, os }) => [
      { text: 'Make sure the Codex CLI is already installed on this computer.' },
      {
        text: `Add a provider block to ${configPath(os, '.codex/config.toml')}, creating the file if it does not exist.`,
        code: [
          `model = "${model}"`,
          'model_provider = "sitegen"',
          '',
          '[model_providers.sitegen]',
          'name = "sitegen"',
          `base_url = "${openaiBase}"`,
          'env_key = "SITEGEN_API_KEY"',
        ].join('\n'),
      },
      {
        text: `Put your key in the variable that config names. ${envNote(os)}`,
        code: exportEnv(os, [['SITEGEN_API_KEY', KEY_PLACEHOLDER]]),
      },
      { text: 'Open a new terminal, run codex, and send a test prompt.' },
    ],
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    protocol: 'openai',
    steps: ({ openaiBase, model }) => [
      { text: 'Open Grok Build settings and choose an OpenAI-compatible or custom API provider.' },
      { text: 'Set the provider base URL to the sitegen OpenAI-compatible endpoint.', code: openaiBase },
      { text: "Paste the API key created in the sitegen dashboard into Grok Build's API key field.", code: KEY_PLACEHOLDER },
      { text: 'Choose a model that appears on the sitegen prices page. Grok Build may call this field Model ID.', code: model },
      { text: 'Save the provider, restart the project if requested, and send a short test prompt.' },
    ],
  },
  {
    id: 'chatgpt-work',
    name: 'ChatGPT Work (managed workspace)',
    protocol: 'managed',
    steps: () => [],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    protocol: 'openai',
    steps: ({ openaiBase, model, os }) => [
      { text: `Open ${configPath(os, '.config/opencode/opencode.json')} (create it if needed).` },
      {
        text: 'Add sitegen as an OpenAI-compatible provider. Keep the API key in the file only if your machine is private; an environment variable or secret manager is safer.',
        code: [
          '{',
          '  "$schema": "https://opencode.ai/config.json",',
          '  "provider": {',
          '    "sitegen": {',
          '      "npm": "@ai-sdk/openai-compatible",',
          '      "name": "sitegen",',
          `      "options": { "baseURL": "${openaiBase}", "apiKey": "${KEY_PLACEHOLDER}" },`,
          `      "models": { "${model}": { "name": "${model}" } }`,
          '    }',
          '  }',
          '}',
        ].join('\n'),
      },
      { text: 'Select the sitegen provider and model in OpenCode, then send a test prompt.' },
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes',
    protocol: 'openai',
    steps: ({ openaiBase, model }) => [
      { text: 'Open Hermes provider settings and choose OpenAI-compatible API (or Custom OpenAI) as the protocol.' },
      { text: 'Enter the sitegen base URL.', code: openaiBase },
      { text: 'Enter the API key from the sitegen dashboard.', code: KEY_PLACEHOLDER },
      { text: 'Set the model identifier to a model currently listed on the sitegen prices page.', code: model },
      { text: "Save the provider and run a short test conversation. Hermes' exact setting names can vary by release." },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    protocol: 'openai',
    steps: ({ openaiBase, model }) => [
      { text: 'Open Cursor Settings and find the Models section.' },
      { text: 'Add a custom model under this exact name, so Cursor sends it through unchanged.', code: model },
      { text: 'Enable the OpenAI API key field and paste your gateway key there.', code: KEY_PLACEHOLDER },
      { text: 'Turn on the base URL override and enter this value.', code: openaiBase },
      {
        text: 'Verify the key, then switch off every other model in the list. Cursor otherwise falls back to its own models, and those calls never reach the gateway or your usage history.',
      },
    ],
  },
  {
    id: 'cline',
    name: 'Cline / Roo Code',
    protocol: 'openai',
    steps: ({ openaiBase, model }) => [
      { text: 'Open the extension settings in VS Code.' },
      { text: 'Set the API Provider to OpenAI Compatible.' },
      { text: 'Set the Base URL.', code: openaiBase },
      { text: 'Paste your gateway key into the API Key field.', code: KEY_PLACEHOLDER },
      { text: 'Enter the Model ID exactly as the prices page spells it.', code: model },
      { text: 'Save, then send a test prompt in a new task.' },
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    protocol: 'openai',
    steps: ({ openaiBase, model, os }) => [
      { text: `Open ${configPath(os, '.continue/config.yaml')}.` },
      {
        text: 'Add the gateway as an OpenAI-compatible model.',
        code: [
          'models:',
          '  - name: sitegen',
          '    provider: openai',
          `    model: ${model}`,
          `    apiBase: ${openaiBase}`,
          `    apiKey: ${KEY_PLACEHOLDER}`,
        ].join('\n'),
      },
      { text: 'Save the file, reload VS Code, and pick sitegen in the model dropdown.' },
    ],
  },
  {
    id: 'zed',
    name: 'Zed',
    protocol: 'openai',
    steps: ({ openaiBase, model }) => [
      { text: 'Open Zed settings (settings.json).' },
      {
        text: 'Point the OpenAI provider at the gateway and declare the model by hand - Zed cannot discover a custom catalogue on its own.',
        code: [
          '{',
          '  "language_models": {',
          '    "openai": {',
          `      "api_url": "${openaiBase}",`,
          '      "available_models": [',
          `        { "name": "${model}", "display_name": "${model}", "max_tokens": 128000 }`,
          '      ]',
          '    }',
          '  }',
          '}',
        ].join('\n'),
      },
      {
        text: 'Open the assistant panel, choose the OpenAI provider, and paste your gateway key when prompted.',
        code: KEY_PLACEHOLDER,
      },
    ],
  },
  {
    id: 'open-webui',
    name: 'Open WebUI',
    protocol: 'openai',
    steps: ({ openaiBase }) => [
      { text: 'Open Settings, then Connections, as an administrator.' },
      { text: 'Add an OpenAI API connection with this base URL.', code: openaiBase },
      { text: 'Paste your gateway key as the API key.', code: KEY_PLACEHOLDER },
      {
        text: 'Save and refresh. The model picker fills itself from GET /v1/models, so only models your plan permits will appear.',
      },
    ],
  },
  { id: 'other', name: 'Other application', protocol: 'universal', steps: () => [] },
];

function Field({
  label,
  value,
  copyable = true,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-100 py-3 last:border-b-0">
      <span className="text-sm text-zinc-600">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-xs text-zinc-900">{value}</code>
        {copyable ? <CopyButton value={value} label="Copy" /> : null}
      </span>
    </div>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 pr-24 text-xs leading-relaxed text-zinc-800">
        {code}
      </pre>
      <CopyButton value={code} className="absolute right-2 top-2" />
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="mt-5 space-y-4">
      {steps.map((step, index) => (
        <li key={step.text} className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-600">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-6 text-zinc-700">{step.text}</p>
            {step.code ? <Snippet code={step.code} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function DownloadSetupButton({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  const download = () => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <button
      type="button"
      onClick={download}
      className="min-h-9 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
    >
      Download setup
    </button>
  );
}

function ManagedWorkspaceSetup({
  openaiBase,
  model,
}: {
  openaiBase: string;
  model: string;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold text-zinc-900">ChatGPT Work (managed workspace)</h2>
      <p className="mt-1 text-sm leading-6 text-zinc-600">
        Standard hosted ChatGPT Work settings do not provide a general custom API base URL.
        Connect sitegen through an organization-approved custom connector or internal gateway,
        configured by your workspace administrator.
      </p>
      <Steps
        steps={[
          { text: 'Ask your ChatGPT Work administrator whether external custom connectors or an internal action gateway are enabled for your workspace.' },
          { text: 'In that approved integration, configure the OpenAI-compatible base URL and bearer authentication.', code: `${openaiBase}\nAuthorization: Bearer ${KEY_PLACEHOLDER}` },
          { text: 'Use a model identifier currently listed on the sitegen prices page.', code: model },
          { text: 'Test the connector with a non-sensitive prompt. Keep the sitegen key in the connector secret store; do not paste it into a normal ChatGPT conversation or browser setting.' },
        ]}
      />
      <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm leading-6 text-amber-900">
          If your workspace does not support a custom connector, ChatGPT Work cannot be pointed at
          an arbitrary third-party API from its regular settings. Use Codex, Claude Code, Grok Build,
          or another supported client for a direct sitegen connection.
        </p>
      </div>
    </div>
  );
}

function setupBundle({
  appName,
  osLabel,
  protocol,
  steps,
  openaiBase,
  anthropicBase,
  model,
  anthropicModel,
}: {
  appName: string;
  osLabel: string;
  protocol: Protocol;
  steps: Step[];
  openaiBase: string;
  anthropicBase: string;
  model: string;
  anthropicModel: string;
}): string {
  const body = steps.length
    ? steps
        .map((step, index) =>
          [`${index + 1}. ${step.text}`, step.code ? `\n   \`\`\`\n   ${step.code}\n   \`\`\`` : ''].join(''),
        )
        .join('\n\n')
    : protocol === 'managed'
      ? [
        '1. Standard hosted ChatGPT Work settings do not accept an arbitrary custom API base URL.',
        '2. Ask a workspace administrator to configure an approved custom connector or internal gateway.',
        `3. Give that integration the OpenAI-compatible base URL: ${openaiBase}`,
        `4. Use model: ${model}`,
        '5. Store the API key in the connector secret store. This download contains only a placeholder, never a live key.',
        ].join('\n\n')
      : [
          '1. Find Custom provider or OpenAI-compatible in the application settings.',
          `2. Use the OpenAI-compatible base URL: ${openaiBase}`,
          `3. Use model: ${model}`,
          `4. Enter the API key from Dashboard > API keys. This download contains only a placeholder, never a live key.`,
        ].join('\n\n');

  return [
    `# sitegen setup: ${appName}`,
    '',
    `Operating system: ${osLabel}`,
    `Protocol: ${protocol === 'anthropic' ? 'Anthropic Messages' : protocol === 'managed' ? 'Managed workspace connector' : 'OpenAI-compatible'}`,
    '',
    '## Gateway values',
    '',
    `OpenAI-compatible base URL: ${openaiBase}`,
    `Anthropic-compatible base URL: ${anthropicBase}`,
    `OpenAI Chat Completions endpoint: ${openaiBase}/chat/completions`,
    `OpenAI Responses endpoint: ${openaiBase}/responses`,
    `Anthropic Messages endpoint: ${anthropicBase}/v1/messages`,
    `OpenAI model: ${model}`,
    `Anthropic model: ${anthropicModel}`,
    `API key placeholder: ${KEY_PLACEHOLDER}`,
    '',
    '## Steps',
    '',
    body,
    '',
    'This file contains a placeholder only. Create or copy the real key from Dashboard > API keys, and keep it out of source control.',
    '',
  ].join('\n');
}

function EndpointSummary({
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
  return (
    <div className="mt-6 border-t border-zinc-200 pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900">Gateway values</h3>
        <span className="text-xs text-zinc-500">The key is created under Dashboard -&gt; API keys.</span>
      </div>
      <div className="mt-2">
        <Field label="OpenAI-compatible base URL" value={openaiBase} />
        <Field label="OpenAI Chat Completions" value={`${openaiBase}/chat/completions`} />
        <Field label="OpenAI Responses" value={`${openaiBase}/responses`} />
        <Field label="Anthropic-compatible base URL" value={anthropicBase} />
        <Field label="Anthropic Messages" value={`${anthropicBase}/v1/messages`} />
        <Field label="OpenAI model example" value={model} />
        <Field label="Anthropic model example" value={anthropicModel} />
        <Field label="API key (placeholder only)" value={KEY_PLACEHOLDER} />
      </div>
      <p className="mt-3 text-xs leading-5 text-zinc-500">
        Use the base URL when the client asks for a provider endpoint. Use a full path only when a
        client explicitly asks for a request URL. Model names and availability can change, so check
        the prices page before saving a model.
      </p>
    </div>
  );
}

export interface ReserveEndpoints {
  openai: string;
  anthropic: string;
}

export function SetupClient({
  openaiBase,
  anthropicBase,
  model,
  anthropicModel,
  reserve,
}: {
  openaiBase: string;
  anthropicBase: string;
  model: string;
  anthropicModel: string;
  reserve: ReserveEndpoints | null;
}) {
  const [appId, setAppId] = useState('claude-code');
  const [os, setOs] = useState<OsKey>('windows');

  const app = APPS.find((entry) => entry.id === appId) ?? APPS[0];
  // A Claude-shaped client can address any model the gateway routes, but
  // offering it a Gemini id by default reads as a mistake - show the family
  // whose name matches the protocol it speaks.
  const suggested = app.protocol === 'anthropic' ? anthropicModel : model;
  const steps = useMemo(
    () => app.steps({ openaiBase, anthropicBase, model: suggested, os }),
    [app, openaiBase, anthropicBase, suggested, os],
  );
  const base = app.protocol === 'anthropic' ? anthropicBase : openaiBase;
  const osLabel =
    app.protocol === 'managed'
      ? 'Workspace-managed'
      : OS_OPTIONS.find((entry) => entry.value === os)?.label ?? '';
  const downloadContent = setupBundle({
    appName: app.name,
    osLabel,
    protocol: app.protocol,
    steps,
    openaiBase,
    anthropicBase,
    model,
    anthropicModel,
  });

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 sm:p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-700">Application</span>
          <select
            value={appId}
            onChange={(event) => setAppId(event.target.value)}
            className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900"
          >
            {APPS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-zinc-700">Operating system</span>
          <select
            value={os}
            onChange={(event) => setOs(event.target.value as OsKey)}
            disabled={app.protocol === 'universal' || app.protocol === 'managed'}
            className="min-h-11 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-900 disabled:opacity-50"
          >
            {OS_OPTIONS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <hr className="my-6 border-zinc-200" />

      {app.protocol === 'universal' ? (
        <div>
          <h2 className="text-base font-semibold text-zinc-900">
            Universal setup for another application
          </h2>
          <p className="mt-1 text-sm leading-6 text-zinc-600">
            In the application settings, find Custom provider or OpenAI-compatible and enter these
            values.
          </p>
          <div className="mt-4">
            <Field label="Provider" value="OpenAI-compatible" copyable={false} />
            <Field label="Base URL" value={openaiBase} />
            <Field label="API Key" value="Your API key from the dashboard" copyable={false} />
            <Field label="Model" value={model} />
          </div>
          <p className="mt-4 text-sm leading-6 text-zinc-600">
            If the field asks for a full Chat Completions endpoint, use{' '}
            <code className="font-mono text-xs text-zinc-800">{openaiBase}/chat/completions</code>.
            For an Anthropic or Claude Messages base URL, use{' '}
            <code className="font-mono text-xs text-zinc-800">{anthropicBase}</code>.
          </p>
        </div>
      ) : app.protocol === 'managed' ? (
        <ManagedWorkspaceSetup openaiBase={openaiBase} model={model} />
      ) : (
        <div>
          <h2 className="text-base font-semibold text-zinc-900">
            {app.name} - {osLabel}
          </h2>
          <p className="mt-1 text-sm leading-6 text-zinc-600">
            Speaks the{' '}
            {app.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions'} format,
            so its base URL is <code className="font-mono text-xs text-zinc-800">{base}</code>.
          </p>
          <Steps steps={steps} />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-5">
        <p className="max-w-xl text-xs leading-5 text-zinc-500">
          Download a local Markdown copy of this selection. It includes endpoint values and a
          placeholder only; it never includes a live API key.
        </p>
        <DownloadSetupButton content={downloadContent} filename={`sitegen-${app.id}-setup.md`} />
      </div>

      <EndpointSummary
        openaiBase={openaiBase}
        anthropicBase={anthropicBase}
        model={model}
        anthropicModel={anthropicModel}
      />

      <div className="mt-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
        <h3 className="text-sm font-semibold text-zinc-900">Connection problems</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          ECONNRESET, repeated timeouts, and streaming connections that reset are network-level
          problems rather than a bad key: a key the gateway rejects comes back as a clean 401 carrying
          a request id, not a dropped socket.
        </p>
        {reserve ? (
          <>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              For manual configuration, use the reserve base URL that matches the application
              protocol:
            </p>
            <div className="mt-2">
              <Field label="OpenAI-compatible applications" value={reserve.openai} />
              <Field label="Anthropic / Claude-compatible applications" value={reserve.anthropic} />
            </div>
          </>
        ) : null}
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          One application may work while another fails because they use different network protocols -
          a client that streams over HTTP/2 can reset where a plain request succeeds. Retrying with
          streaming turned off is the quickest way to tell the two apart.
        </p>
      </div>
    </section>
  );
}
