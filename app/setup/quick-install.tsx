'use client';

import { useState, useSyncExternalStore } from 'react';
import { CopyButton } from './copy-button';
import type { OsKey } from './shared';

const TABS: { value: OsKey; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
];

interface Platform {
  terminal: string;
  install: string;
  uninstall: string;
  script: string;
  needs: string;
}

function platform(os: OsKey, base: string): Platform {
  if (os === 'windows') {
    return {
      terminal: 'Open PowerShell (press the Windows key, type PowerShell, press Enter) and run:',
      install: `irm ${base}/install.ps1 | iex`,
      uninstall: `irm ${base}/uninstall.ps1 | iex`,
      script: `${base}/install.ps1`,
      needs: 'Nothing extra: Windows PowerShell is built in.',
    };
  }
  return {
    terminal: `Open ${os === 'macos' ? 'Terminal' : 'a terminal'} and run:`,
    install: `curl -fsSL ${base}/install.sh | sh`,
    uninstall: `curl -fsSL ${base}/uninstall.sh | sh`,
    script: `${base}/install.sh`,
    needs:
      os === 'macos'
        ? "Python 3 from Apple's command line tools. If the script says it is missing, run xcode-select --install first."
        : 'curl and Python 3.8 or newer, which most distributions include.',
  };
}

/** Best guess at the visitor's system, so the right command shows first. */
function detectOs(): OsKey | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent}`.toLowerCase();
  if (hint.includes('win')) return 'windows';
  if (hint.includes('mac')) return 'macos';
  if (hint.includes('linux') || hint.includes('x11')) return 'linux';
  return null;
}

function Command({ code }: { code: string }) {
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 pr-24 font-mono text-xs leading-relaxed text-zinc-800">
        {code}
      </pre>
      <CopyButton value={code} className="absolute right-2 top-2" />
    </div>
  );
}

// The platform never changes while the page is open, so there is nothing to
// subscribe to; the server renders the Windows tab and the client corrects it.
const noSubscription = () => () => {};

export function QuickInstall({ base }: { base: string }) {
  const detected = useSyncExternalStore(noSubscription, detectOs, () => null);
  const [chosen, setOs] = useState<OsKey | null>(null);
  const os = chosen ?? detected ?? 'windows';

  const current = platform(os, base);

  return (
    <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-5 sm:p-6">
      <h2 className="text-base font-semibold text-zinc-900">
        Automatic setup for Codex, Claude Code and OpenCode
      </h2>
      <p className="mt-1 text-sm leading-6 text-zinc-600">
        One command connects Codex (CLI, desktop app and IDE extension) to the GPT models your plan
        includes, Claude Code (CLI and IDE extensions) to the Claude models, and OpenCode (CLI and
        desktop app) to every chat model. Install the ones you use first, then run it.
      </p>

      <div role="tablist" aria-label="Operating system" className="mt-5 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={os === tab.value}
            onClick={() => setOs(tab.value)}
            className={`min-h-9 rounded-md border px-3 py-1.5 text-sm font-medium ${
              os === tab.value
                ? 'border-zinc-900 bg-zinc-900 text-white'
                : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-4">
        <p className="text-sm leading-6 text-zinc-700">{current.terminal}</p>
        <Command code={current.install} />

        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm leading-6 text-zinc-600">
          <li>
            It asks which of the tools it finds to set up: all of them, or any you pick. The ones
            you leave out are not touched.
          </li>
          <li>
            It asks for an API key from Dashboard -&gt; API keys and stores it{' '}
            {os === 'windows' ? 'encrypted for your Windows account' : 'in a file only you can read'}.
            The key is never written into the apps&apos; settings.
          </li>
          <li>It lets you pick a default model for each, backs up your current settings first, and
            sends one short test message to confirm each connection.</li>
          <li>Run it again at any time to change the key or refresh the model list.</li>
        </ul>

        <p className="mt-4 text-xs leading-5 text-zinc-500">
          Needs: {current.needs}{' '}
          <a href={current.script} target="_blank" rel="noopener" className="underline">
            Read the script
          </a>{' '}
          before you run it.
        </p>

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-zinc-700">Undo the setup</summary>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            {os === 'windows'
              ? 'Press the Windows key, type "Undo sitegen" and press Enter. Or run this in PowerShell:'
              : 'Run this in a terminal (or, without internet, sh ~/.sitegen/uninstall.sh):'}
          </p>
          <Command code={current.uninstall} />
          <p className="mt-2 text-xs leading-5 text-zinc-500">
            It puts your previous Codex, Claude Code and OpenCode settings back exactly as they were
            and deletes the saved key.
          </p>
        </details>
      </div>

      <p className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600">
        The ChatGPT and Claude chat apps (desktop, web and phone) cannot be pointed at another server,
        so they keep using your own OpenAI and Anthropic accounts. For chat through sitegen, use a
        client from the list below that accepts a custom API address.
      </p>
    </section>
  );
}
