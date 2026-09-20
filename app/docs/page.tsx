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
  forbidden: { status: '403', meaning: 'The key is valid but lacks the required scope.' },
  invalid_request: { status: '400', meaning: 'Body failed validation. The message names the field.' },
  rate_limited: { status: '429', meaning: 'Per-key requests-per-minute exceeded. See Retry-After.' },
  insufficient_credits: { status: '402', meaning: 'Balance too low to cover the estimated cost.' },
  idempotency_conflict: {
    status: '409',
    meaning: 'The key is in use by another request or was used for a different body.',
  },
  channel_unavailable: { status: '503', meaning: 'No healthy channel for your plan right now.' },
  generation_failed: { status: '502', meaning: 'The model returned nothing valid after retries.' },
  not_found: { status: '404', meaning: 'No such resource.' },
  model_not_found: { status: '404', meaning: 'Unknown model, or one your plan cannot use.' },
  content_policy_violation: { status: '400', meaning: 'Prompt was flagged by content moderation.' },
  internal_error: { status: '500', meaning: 'Unexpected server fault. Safe to retry.' },
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4">
      <h2 className="mb-4 text-xl font-semibold text-zinc-900">{title}</h2>
      <div className="space-y-4 text-zinc-700 leading-relaxed">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs leading-relaxed text-zinc-800">
      {children}
    </pre>
  );
}

function Tok({ children }: { children: ReactNode }) {
  return <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

const REQUEST_BODY = `{
  "brief": "A neighbourhood bakery in Portland serving sourdough…",
  "targetPages": ["home", "about", "menu"],
  "maxRounds": 2
}`;

const RESPONSE_BODY = `{
  "spec": {
    "businessName": "Grain & Gather Bakery",
    "tagline": "Handcrafted sourdough in the heart of Portland",
    "theme": {
      "primaryColor": "#8B4513",
      "accentColor": "#D2691E",
      "fontPairing": "serif-clean",
      "tone": "warm"
    },
    "pages": [
      {
        "slug": "home",
        "title": "Home",
        "sections": [
          { "type": "hero", "heading": "Fresh bread…", "subheading": "…", "ctaText": "…" },
          { "type": "features", "heading": "…", "items": […] }
        ]
      }
    ]
  },
  "usage": {
    "input_tokens": 512,
    "output_tokens": 1843,
    "cached_tokens": 0
  },
  "credits_charged": 42,
  "balance_after": 9958,
  "request_id": "550e8400-e29b-41d4-a716-446655440000"
}`;

const CURL = `curl -sS -X POST ${APP_URL}/v1/generate \\
  -H "Authorization: Bearer sk_live_YOUR_API_KEY_HERE" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{
    "brief": "A neighbourhood bakery in Portland serving sourdough…",
    "targetPages": ["home", "about", "menu"],
    "maxRounds": 2
  }'`;

const CHAT_REQUEST = `{
  "model": "gemini-2.0-flash-exp",
  "messages": [
    {"role": "user", "content": "What is the capital of France?"}
  ],
  "max_tokens": 100
}`;

const CHAT_RESPONSE = `{
  "id": "chatcmpl-550e8400-e29b-41d4-a716-446655440000",
  "object": "chat.completion",
  "created": 1640995200,
  "model": "gemini-2.0-flash-exp",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The capital of France is Paris."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 8,
    "total_tokens": 20
  }
}`;

const ERROR_SHAPE = `{
  "error": {
    "code": "insufficient_credits",
    "message": "insufficient credits: need 50, balance 12",
    "request_id": "550e8400-e29b-41d4-a716-446655440000"
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
            Generate structured site specs and run OpenAI-compatible chat completions over HTTP.
          </p>
        </header>

        <nav className="mt-8 mb-10 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600">
          {[
            ['authentication', 'Authentication'],
            ['generate', 'POST /v1/generate'],
            ['chat', 'POST /v1/chat/completions'],
            ['models', 'GET /v1/models'],
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
              A missing or unrecognised key returns <Tok>unauthorized</Tok>. A valid key without the
              required scope returns <Tok>forbidden</Tok>. Send keys from a server you control — never
              from a browser.
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
              channel health; there is no model override. Requires the <Tok>generate</Tok> scope.
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

          <Section id="chat" title="POST /v1/chat/completions">
            <p>
              OpenAI-compatible chat completions. Requests must be{' '}
              <Tok>Content-Type: application/json</Tok>. Requires the <Tok>chat</Tok> scope.
            </p>
            <Code>{CHAT_REQUEST}</Code>
            <p>
              The <Tok>model</Tok> field selects from models your plan permits. Use{' '}
              <Tok>GET /v1/models</Tok> for the full list. Streaming responses are not yet supported.
            </p>
            <h3 className="pt-2 text-base font-semibold text-zinc-900">200 response</h3>
            <Code>{CHAT_RESPONSE}</Code>
            <p>
              Unlike <Tok>/v1/generate</Tok>, credits charged and balance are not returned in the
              body. Check your usage dashboard for billing details.
            </p>
          </Section>

          <Section id="models" title="GET /v1/models">
            <p>
              Lists models available to your plan. Each model has an <Tok>id</Tok> (the public model
              name you pass in chat completion requests), <Tok>object: &quot;model&quot;</Tok>, and an{' '}
              <Tok>owned_by</Tok> string. Requires the <Tok>chat</Tok> scope.
            </p>
            <Code>{`{
  "object": "list",
  "data": [
    {
      "id": "gemini-2.0-flash-exp",
      "object": "model",
      "created": 1640995200,
      "owned_by": "system"
    }
  ]
}`}</Code>
          </Section>

          <Section id="idempotency" title="Idempotency">
            <p>
              <Tok>Idempotency-Key</Tok> is required on <Tok>/v1/generate</Tok> and optional on{' '}
              <Tok>/v1/chat/completions</Tok> — at most 200 characters, and unique per logical request
              (a UUID works). If absent on chat completions, a server-generated UUID is used.
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
            <p>
              Every non-2xx response uses one shape. Log the request id — it identifies the call in
              your usage history and in support requests.
            </p>
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
