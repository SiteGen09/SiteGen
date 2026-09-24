import Link from 'next/link';
import { listPublicPrices } from '@/lib/dashboard/queries';
import { ThemeToggle } from '../theme-toggle';
import { ApiExamples } from './api-examples';
import { SetupClient, type ReserveEndpoints } from './setup-client';
import { SitegenLogo } from '../_components/sitegen-logo';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Setup - sitegen',
  description:
    'Configure Claude Code, Codex, Grok Build, OpenCode, Hermes, ChatGPT Work connectors, and other compatible clients for sitegen.',
};

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/**
 * A second origin that bypasses the CDN, for clients whose streaming
 * connections the proxy resets. It is optional: with nothing configured the
 * troubleshooting panel keeps its advice and simply offers no alternate URL,
 * rather than printing one that does not resolve.
 */
function reserveEndpoints(): ReserveEndpoints | null {
  const raw = process.env.NEXT_PUBLIC_RESERVE_URL?.replace(/\/+$/, '');
  if (!raw) return null;
  return { openai: `${raw}/v1`, anthropic: raw };
}

/** Fall back to a literal only when the catalogue is empty or unreachable. */
const FALLBACK_MODEL = 'gpt-4o-mini';
const FALLBACK_ANTHROPIC_MODEL = 'claude-sonnet-5';

export default async function SetupPage() {
  let model = FALLBACK_MODEL;
  let anthropicModel = FALLBACK_ANTHROPIC_MODEL;

  try {
    const prices = await listPublicPrices();
    // Per-request rows are media models; the chat routes only serve token pricing.
    const chat = prices.filter((price) => price.pricingType === 'token');
    const first = chat[0];
    if (first) model = first.model;
    const claude = chat.find(
      (price) => price.vendor.toLowerCase() === 'anthropic' || price.model.startsWith('claude'),
    );
    if (claude) anthropicModel = claude.model;
  } catch {
    // A catalogue outage should not take the setup instructions down with it.
  }

  const openaiBase = `${APP_URL}/v1`;

  return (
    <main className="min-w-0 flex-1 bg-zinc-50 px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="sitegen home" className="inline-flex shrink-0 text-xl text-zinc-900">
            <SitegenLogo />
          </Link>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href="/docs" className="text-sm text-zinc-600">
              API docs
            </Link>
            <Link href="/prices" className="text-sm text-zinc-600">
              Model prices
            </Link>
            <ThemeToggle />
          </div>
        </nav>

        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Setup</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Choose an application and follow the short setup. Create the key first under{' '}
          <Link href="/dashboard/keys" className="underline">
            Dashboard -&gt; API keys
          </Link>
          {' '} - it is shown once, at creation.
        </p>

        <div className="mt-8">
          <SetupClient
            openaiBase={openaiBase}
            anthropicBase={APP_URL}
            model={model}
            anthropicModel={anthropicModel}
            reserve={reserveEndpoints()}
          />
        </div>

        <ApiExamples
          openaiBase={openaiBase}
          anthropicBase={APP_URL}
          model={model}
          anthropicModel={anthropicModel}
        />

        <p className="mt-8 text-sm leading-6 text-zinc-600">
          Model names come from{' '}
          <Link href="/prices" className="underline">
            Model prices
          </Link>
          , and only models your plan permits will answer. The full request and response shapes,
          error codes, idempotency, and billing are in the{' '}
          <Link href="/docs" className="underline">
            API reference
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
