import Link from 'next/link';
import type { ReactNode } from 'react';
import { ERROR_CODES } from '@/lib/api/errors';
import { FONT_PAIRINGS, TONES } from '@/lib/spec/schema';
import { ThemeToggle } from '../theme-toggle';

export const metadata = {
  title: 'API reference — sitegen',
  description: 'Generate structured site specs over HTTP.',
};

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const ERROR_DETAIL: Record<string, { status: string; meaning: string }> = {
  unauthorized: { status: '401', meaning: 'Missing, malformed, or revoked API key.' },
  forbidden: { status: '403', meaning: 'The key is valid but lacks the `generate` scope.' },
  invalid_request: { status: '400', meaning: 'Body failed validation. The message names the field.' },
  rate_limited: { status: '429', meaning: 'Per-key requests-per-minute exceeded. See Retry-After.' },
  insufficient_credits: { status: '402', meaning: 'Balance too low to cover the estimated cost.' },
  idempotency_conflict: {
    status: '409',
    meaning: 'Idempotency-Key was reused with a different request body.',
  },
  channel_unavailable: { status: '503', meaning: 'No healthy channel for your plan right now.' },
  generation_failed: { status: '502', meaning: 'The model returned nothing valid after retries.' },
  not_found: { status: '404', meaning: 'No such resource.' },
  internal_error: { status: '500', meaning: 'Unexpected server fault. Safe to retry.' },
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8 border-t border-zinc-200 pt-10">
      <h2 className="text-xl font-semibold tracking-tight text-zinc-900">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-zinc-700">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="code-surface overflow-x-auto rounded-lg bg-zinc-900 px-3 py-3.5 text-xs leading-relaxed text-zinc-100 sm:px-4">
      <code>{children}</code>
    </pre>
  );
}

function Tok({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.8125rem] text-zinc-800">
      {children}
    </code>
  );
}

const REQUEST_BODY = `{
  "businessName": "Ridgeline Cycles",     // required, 1-120 chars
  "businessType": "bicycle repair shop",  // required, 1-60 chars
  "description": "Family-run shop doing tune-ups, wheel builds and fittings.",
                                          // required, 1-2000 chars
  "language": "en",                       // optional, 2-12 chars, default "en"
  "details": {                            // optional, <=20 entries, values <=500 chars
    "city": "Boulder, CO",
    "founded": "2011"
  }
}`;

const RESPONSE_BODY = `{
  "spec": {
    "meta": {
      "businessName": "Ridgeline Cycles",
      "tagline": "Tuned, trued, and ready to ride.",
      "language": "en",
      "businessType": "bicycle repair shop"
    },
    "theme": {
      "primaryColor": "#1f6f4a",
      "accentColor": "#f2a541",
      "fontPairing": "space-grotesk-ibm-plex-sans",
      "tone": "friendly"
    },
    "pages": [
      {
        "id": "home",
        "slug": "home",
        "title": "Home",
        "sections": [
          {
            "id": "hero",
            "type": "hero",
            "headline": "Your bike, dialled in",
            "subheadline": "Same-week tune-ups from mechanics who race what they fix.",
            "ctaLabel": "Book a service",
            "ctaHref": "/contact"
          }
        ]
      }
    ]
  },
  "usage": {
    "request_id": "3f9c1a52-8d1e-4a77-9d2b-6c4e0b1a77e5",
    "channel_id": "spec-cheap",
    "input_tokens": 612,
    "output_tokens": 1843,
    "cached_tokens": 0,
    "latency_ms": 7412,
    "credits_charged": 128,
    "balance_after": 49872
  }
}`;

const CURL = `curl -sS -X POST ${APP_URL}/v1/generate \\
  -H "Authorization: Bearer $SITEGEN_API_KEY" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "businessName": "Ridgeline Cycles",
    "businessType": "bicycle repair shop",
    "description": "Family-run shop doing tune-ups, wheel builds and fittings.",
    "language": "en"
  }'`;

const ERROR_SHAPE = `{
  "error": {
    "code": "insufficient_credits",
    "message": "Balance is 40 credits; this request needs at least 120.",
    "request_id": "3f9c1a52-8d1e-4a77-9d2b-6c4e0b1a77e5"
  }
}`;

export default function DocsPage() {
  return (
    <main className="flex-1 bg-white">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <header>
          <div className="flex items-center justify-between gap-4">
            <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-800">
              sitegen
            </Link>
            <ThemeToggle />
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
            API reference
          </h1>
          <p className="mt-3 text-zinc-600">
            One endpoint. Post a brief about a business, get back a validated{' '}
            <Tok>SiteSpec</Tok> plus the exact usage and credits the call consumed.
          </p>
        </header>

        <nav className="mt-8 mb-10 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600">
          {[
            ['authentication', 'Authentication'],
            ['generate', 'POST /v1/generate'],
            ['idempotency', 'Idempotency'],
            ['errors', 'Errors'],
            ['rate-limits', 'Rate limits'],
            ['credits', 'Credits'],
            ['curl', 'Example'],
          ].map(([anchor, label]) => (
            <a key={anchor} href={`#${anchor}`} className="underline hover:text-zinc-900">
              {label}
            </a>
          ))}
        </nav>

        <div className="space-y-10">
          <Section id="authentication" title="Authentication">
            <p>
              Every request carries an API key as a bearer token. Create keys under{' '}
              <Link href="/dashboard/keys" className="underline">
                Dashboard → API keys
              </Link>
              ; the full key is shown once at creation and only its prefix and last four digits are
              stored afterwards.
            </p>
            <Code>{`Authorization: Bearer sk_live_YOUR_API_KEY_HERE`}</Code>
            <p>
              A missing or unrecognised key returns <Tok>unauthorized</Tok>. A valid key without the{' '}
              <Tok>generate</Tok> scope returns <Tok>forbidden</Tok>. Send keys from a server you
              control — never from a browser.
            </p>
          </Section>

          <Section id="generate" title="POST /v1/generate">
            <p>
              Requests must be <Tok>Content-Type: application/json</Tok>. The body is strict:
              unknown keys are rejected rather than ignored, and no string may contain{' '}
              <Tok>&lt;</Tok> or <Tok>&gt;</Tok>.
            </p>
            <Code>{REQUEST_BODY}</Code>
            <p>
              The model and channel are chosen server-side from your plan and the platform&apos;s
              channel health; there is no model override.
            </p>
            <h3 className="pt-2 text-base font-semibold text-zinc-900">200 response</h3>
            <p>
              <Tok>spec.theme.fontPairing</Tok> is one of {FONT_PAIRINGS.join(', ')};{' '}
              <Tok>spec.theme.tone</Tok> is one of {TONES.join(', ')}. A spec holds 1–8 pages, each
              with 1–12 sections drawn from hero, features, about, testimonials, pricing, faq,
              contact, cta, and gallery.
            </p>
            <Code>{RESPONSE_BODY}</Code>
            <p>
              <Tok>credits_charged</Tok> is the settled amount for this call and{' '}
              <Tok>balance_after</Tok> your remaining balance. Both are also written to your usage
              and ledger history.
            </p>
          </Section>

          <Section id="idempotency" title="Idempotency">
            <p>
              <Tok>Idempotency-Key</Tok> is required on every generate call — at most 200 characters,
              and unique per logical request (a UUID works).
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                Replaying a key with the <strong>same</strong> body returns the original stored
                response and charges nothing more.
              </li>
              <li>
                Reusing a key with a <strong>different</strong> body returns{' '}
                <Tok>idempotency_conflict</Tok>.
              </li>
              <li>
                A request still in flight under that key also returns{' '}
                <Tok>idempotency_conflict</Tok>; retry after the first one settles.
              </li>
            </ul>
            <p>
              This makes retries after a timeout safe: reuse the same key and you either get the
              original result or a conflict, never a second charge.
            </p>
          </Section>

          <Section id="errors" title="Errors">
            <p>Every non-2xx response uses one shape. Log the request id — it identifies the call in
              your usage history and in support requests.</p>
            <Code>{ERROR_SHAPE}</Code>
            <div className="overflow-x-auto rounded-lg border border-zinc-200">
              <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Code</th>
                    <th className="px-4 py-2.5 font-medium">HTTP</th>
                    <th className="px-4 py-2.5 font-medium">Meaning</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {ERROR_CODES.map((code) => (
                    <tr key={code}>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-zinc-800">
                        {code}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600">{ERROR_DETAIL[code]?.status}</td>
                      <td className="px-4 py-2.5 text-zinc-600">{ERROR_DETAIL[code]?.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="rate-limits" title="Rate limits">
            <p>
              Limits are per API key, measured in requests per minute, and set by your plan. Exceeding
              one returns <Tok>rate_limited</Tok> with HTTP 429 and a <Tok>Retry-After</Tok> header
              giving whole seconds to wait.
            </p>
            <Code>{`HTTP/1.1 429 Too Many Requests
Retry-After: 12

{"error":{"code":"rate_limited","message":"Rate limit exceeded.","request_id":"…"}}`}</Code>
            <p>
              Honour <Tok>Retry-After</Tok> rather than retrying immediately. Rate-limited calls are
              rejected before any model call, so they cost no credits.
            </p>
          </Section>

          <Section id="credits" title="Credits">
            <p>
              Usage is billed in credits, where <strong>1 credit = $0.0001</strong> of provider cost
              (10,000 credits = $1.00). A call computes provider cost from input, output, and cached
              tokens, multiplies by the channel&apos;s credit multiplier, and rounds up to the next
              whole credit.
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                Credits are <em>held</em> on an estimate before generation and settled to the actual
                amount afterwards; a failed generation releases the hold.
              </li>
              <li>
                Too low a balance returns <Tok>insufficient_credits</Tok> before any model call.
              </li>
              <li>
                Channels on a zero multiplier — including BYOK channels using your own provider key —
                charge 0 credits.
              </li>
            </ul>
            <p>
              Balance, plan, and per-request charges are visible under{' '}
              <Link href="/dashboard/usage" className="underline">
                Dashboard → Usage
              </Link>
              .
            </p>
          </Section>

          <Section id="curl" title="Example">
            <Code>{CURL}</Code>
          </Section>
        </div>
      </div>
    </main>
  );
}
