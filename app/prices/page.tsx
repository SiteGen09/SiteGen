import Link from 'next/link';
import { listPublicPrices } from '@/lib/dashboard/queries';
import { ThemeToggle } from '../theme-toggle';
import { PricesTable } from './prices-table';
import { SitegenLogo } from '../_components/sitegen-logo';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Model prices — sitegen' };

export default async function PricesPage() {
  const prices = await listPublicPrices();
  return (
    <main className="min-w-0 flex-1 bg-zinc-50 px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <nav className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="sitegen home" className="inline-flex shrink-0 text-xl text-zinc-900">
            <SitegenLogo />
          </Link>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href="/docs" className="text-sm text-zinc-600">
              API docs
            </Link>
            <Link href="/setup" className="text-sm text-zinc-600">
              Setup
            </Link>
            <Link href="/dashboard/routing" className="text-sm text-zinc-600">
              Choose a source
            </Link>
            <ThemeToggle />
          </div>
        </nav>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Model prices</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-600">
          Compare the prices for capabilities currently enabled on your plan. Chat is priced per
          million tokens; request-priced capabilities appear per job when enabled. All prices are
          in credits and include the displayed provider’s multiplier. One credit is $0.0001.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          “Up to” is the amount reserved for a request-priced job; the actual charge may be lower.
          Reference list prices appear where available and use the same credit units.
          Unpublished prices are not shown as zero.
        </p>
        <PricesTable prices={prices} />
      </div>
    </main>
  );
}
