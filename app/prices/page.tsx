import Link from 'next/link';
import { listPublicPrices } from '@/lib/dashboard/queries';
import { ThemeToggle } from '../theme-toggle';
import { PricesTable } from './prices-table';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Model prices — sitegen' };

export default async function PricesPage() {
  const prices = await listPublicPrices();
  return (
    <main className="min-w-0 flex-1 bg-zinc-50 px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <nav className="mb-10 flex items-center justify-between">
          <Link href="/" className="font-semibold text-zinc-900">
            sitegen
          </Link>
          <div className="flex items-center gap-5">
            <Link href="/docs" className="text-sm text-zinc-600">
              API docs
            </Link>
            <Link href="/dashboard/routing" className="text-sm text-zinc-600">
              Choose a source
            </Link>
            <ThemeToggle />
          </div>
        </nav>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">Model prices</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-600">
          Compare prices in credits per million tokens, or per request where marked. Prices include
          the family default source’s multiplier; if it does not serve a model, the best available
          source is shown. Your chosen source can change your price. One credit is $0.0001.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          Vendor list prices are converted to the same credit units. Unpublished prices and context
          limits are shown as unknown.
        </p>
        <PricesTable prices={prices} />
      </div>
    </main>
  );
}
