import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';

export default function LandingPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-5 py-12 sm:px-6 sm:py-16">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">
            sitegen
          </h1>
          <ThemeToggle />
        </div>
        <p className="text-zinc-600">
          A generation API for site specs. Send a brief, get back structured, validated JSON you can
          render — with per-request credit accounting, your own provider keys, and honest usage
          reporting.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex min-h-11 items-center rounded-md border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
          >
            Create account
          </Link>
          <Link
            href="/docs"
            className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-zinc-700 underline hover:text-zinc-900"
          >
            API docs
          </Link>
          <Link href="/prices" className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-zinc-700 underline">Model prices</Link>
        </div>
      </div>
    </main>
  );
}
