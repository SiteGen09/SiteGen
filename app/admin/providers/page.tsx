import Link from 'next/link';
import { listProviderPricing, type ProviderPricing } from '@/lib/admin/provider-pricing';
import { requireAdmin } from '@/lib/api/admin';
import { sql } from '@/lib/db';
import { Card, PageTitle } from '../_components/ui';
import { ProviderForm } from './provider-form';

export const dynamic = 'force-dynamic';

/** Until the routing_providers migration runs, the page explains itself instead of failing. */
async function loadProviders(): Promise<ProviderPricing[] | null> {
  try {
    return await listProviderPricing(sql);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01' || code === '42883') return null;
    throw err;
  }
}

export default async function ProvidersPage() {
  await requireAdmin();
  const providers = await loadProviders();
  return (
    <>
      <PageTitle
        title="Provider pricing"
        subtitle="Set one price multiplier and the public name for every model a provider serves."
      />
      {providers === null ? (
        <Card>
          <p className="text-sm text-amber-300">
            The database is missing the provider settings table. Apply migration
            20260925120000_routing_provider_settings.sql, then reload.
          </p>
        </Card>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-zinc-400">
            A saved multiplier applies to every source of the provider, including sources a
            catalog import adds or rewrites later. To price one source differently, release the
            provider-wide multiplier and use{' '}
            <Link href="/admin/sources" className="text-indigo-300 underline underline-offset-4">
              Sources
            </Link>
            .
          </p>
          {providers.map((provider) => (
            <Card key={provider.id}>
              <ProviderForm provider={provider} />
            </Card>
          ))}
          {!providers.length && (
            <Card>
              <p className="text-sm text-zinc-400">No provider serves any source yet.</p>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
