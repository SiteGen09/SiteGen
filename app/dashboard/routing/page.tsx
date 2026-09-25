import Link from 'next/link';
import { FAMILIES, MODALITIES, MODALITY_LABELS, PROVIDER_PREFERENCE_KEY, routingKey } from '@/lib/ai/source-types';
import { listSources, loadRoutingPreferences } from '@/lib/ai/sources';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { getBalance, getEntitlement, listModelCatalog, listRoutingPriceHistory } from '@/lib/dashboard/queries';
import { groupRoutingProviders } from '@/lib/dashboard/routing-catalog';
import {
  publicRoutingProviderLabel,
  publicRoutingSourceId,
  routingProviderIdentity,
  selectableRoutingProviders,
} from '@/lib/ai/routing-provider';
import { loadDefaultRoutingProvider, loadRoutingProviderNames } from '@/lib/ai/routing-provider-names';
import type { RoutingPriceHistoryEntry } from '@/lib/dashboard/routing-history';
import { requireUser } from '@/lib/dashboard/session';
import { Card, PageHeader, Table, EmptyRow, formatCredits, formatCreditsUsd, formatTimestamp } from '../ui';
import { DefaultProviderPicker } from './default-provider-picker';
import { SourcePicker } from './source-picker';
import { ProviderList } from './provider-list';

export const metadata = { title: 'Routing — sitegen' };

function historyPrice(value: number | null, unit: RoutingPriceHistoryEntry['unit']) {
  if (value === null) return '—';
  if (unit === 'multiplier') return '×' + value;
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 6 }) +
    (unit === 'usd_per_job' ? ' / job' : ' / 1M tokens');
}

export default async function RoutingPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  const tab = params.tab === 'history' ? 'history' : 'channels';
  const [balance, entitlement, sources, preferences, catalog, providerNames, defaultProvider] = await Promise.all([
    getBalance(), getEntitlement(user.id), listSources(), loadRoutingPreferences(user.id), listModelCatalog(),
    loadRoutingProviderNames(), loadDefaultRoutingProvider(),
  ]);
  const models = catalog.filter((model) => !model.isByok && planMeetsMinimum(entitlement.planKey, model.minPlan));
  const providers = groupRoutingProviders(models, providerNames);
  const sourceProviders = new Map(providers.flatMap((provider) => provider.sourceIds.map((id) => [id, provider] as const)));
  const priceHistory = tab === 'history' ? await listRoutingPriceHistory(models) : [];
  const providerChoices = selectableRoutingProviders(sources.filter((source) =>
    source.status !== 'off' && planMeetsMinimum(entitlement.planKey, source.min_plan) &&
    sourceProviders.has(publicRoutingSourceId(source.id))), providerNames);
  const userProvider = providerChoices.find((provider) => provider.id === preferences.get(PROVIDER_PREFERENCE_KEY));
  // Auto starts on the user's own default provider, else the platform's.
  const startProvider = userProvider?.id ?? defaultProvider;
  const startLabel = startProvider ? publicRoutingProviderLabel(startProvider, providerNames) : null;
  const pairs = FAMILIES.flatMap((family) => MODALITIES.flatMap((modality) => {
    const eligible = sources.filter((source) => source.family === family && source.modality === modality &&
      source.status !== 'off' &&
      planMeetsMinimum(entitlement.planKey, source.min_plan) &&
      sourceProviders.has(publicRoutingSourceId(source.id)),
    );
    // Mirrors the dispatcher: the user's provider, then the platform's, then source defaults.
    const on = (provider: string | null | undefined) => eligible.filter((source) =>
      provider && routingProviderIdentity({ sourceId: source.id, sourceLabel: source.label }).id === provider);
    const onDefault = [on(userProvider?.id), on(defaultProvider)].find((list) => list.length) ?? [];
    const autoStart = onDefault.find((source) => source.is_default) ?? onDefault[0];
    return eligible.length ? [{ family, modality, eligible: eligible.map((source) => ({
      ...source,
      is_default: autoStart ? source === autoStart : source.is_default,
      id: publicRoutingSourceId(source.id),
      label: sourceProviders.get(publicRoutingSourceId(source.id))!.label,
    })) }] : [];
  }));
  const manualCount = pairs.filter(({ family, modality }) => preferences.has(routingKey(family, modality))).length;
  const summary = [
    startLabel ? 'Starts with ' + startLabel : 'Auto',
    manualCount ? manualCount + ' custom ' + (manualCount === 1 ? 'choice' : 'choices') : 'Auto for all models',
  ].join(' · ');

  return <>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <PageHeader title="Routing" description="Choose your providers and explore their models and prices." />
      <p className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-500">
        Available credits <span className="ml-1 font-semibold tabular-nums text-zinc-900">{formatCredits(balance)}</span>
        <span className="ml-1 tabular-nums">(≈ {formatCreditsUsd(balance)})</span>
      </p>
    </div>

    <details className="mb-6 rounded-xl border border-zinc-200 bg-white">
      <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-zinc-900">
        Routing preferences
        <span className="ml-3 font-normal text-zinc-500">{summary}</span>
      </summary>
      <div className="border-t border-zinc-200 p-4 sm:p-5">
        <p className="mb-4 max-w-3xl text-sm leading-6 text-zinc-600">
          Auto starts with the default provider and tries available backups if it cannot respond. You’re charged at the rate of the provider and model that answer.
        </p>
        <DefaultProviderPicker
          key={userProvider?.publicId ?? ''}
          providers={providerChoices}
          selected={userProvider?.publicId ?? ''}
          platformLabel={defaultProvider ? publicRoutingProviderLabel(defaultProvider, providerNames) : null}
        />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {pairs.map(({ family, modality, eligible }) => {
            const savedInternal = preferences.get(routingKey(family, modality)) ?? '';
            const saved = savedInternal ? publicRoutingSourceId(savedInternal) : '';
            return <SourcePicker key={routingKey(family, modality) + ':' + saved} family={family} modality={modality} sources={eligible} selected={saved} />;
          })}
          {!pairs.length && <Card><p className="text-sm text-zinc-600">No providers are available on your plan yet.</p></Card>}
        </div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">
          Chat, image and video choices are saved separately. Auto can switch providers before a media job is accepted; a job already running is not restarted.
        </p>
      </div>
    </details>

    <nav className="mb-5 flex gap-6 border-b border-zinc-200" aria-label="Routing details">
      {[{ id: 'channels', label: 'Channels', href: '/dashboard/routing' }, { id: 'history', label: 'Price history', href: '/dashboard/routing?tab=history' }].map((item) =>
        <Link key={item.id} href={item.href} aria-current={tab === item.id ? 'page' : undefined} className={
          tab === item.id ? 'border-b-2 border-zinc-900 px-1 pb-3 text-sm font-medium text-zinc-900' :
            'border-b-2 border-transparent px-1 pb-3 text-sm font-medium text-zinc-500 hover:text-zinc-900'
        }>{item.label}</Link>,
      )}
    </nav>

    {tab === 'channels' ? <>
      <p className="mb-4 text-sm text-zinc-500">{providers.length} {providers.length === 1 ? 'provider' : 'providers'} · Open a provider to see its configured models and prices.</p>
      <ProviderList providers={providers} defaultProviderId={startProvider ? providerChoices.find((provider) => provider.id === startProvider)?.publicId : undefined} />
    </> : <>
      <p className="mb-4 text-sm leading-6 text-zinc-500">
        Recent recorded model-rate and price-multiplier changes. Model rates are shown in USD before the provider’s multiplier; current prices in credits are inside each channel.
      </p>
      <Table head={['Date and time', 'Provider / Model', 'Price changed', 'Previous', 'New']} minWidth="min-w-[48rem]">
        {!priceHistory.length && <EmptyRow colSpan={5}>No price changes recorded yet.</EmptyRow>}
        {priceHistory.map((entry) => <tr key={entry.id}>
          <td className="p-4 align-top text-zinc-500">{formatTimestamp(entry.createdAt)}</td>
          <td className="p-4 align-top">
            <div className="font-medium text-zinc-900">{entry.providerLabel}</div>
            <div className="mt-1 text-xs text-zinc-500">{entry.modelLabel ?? entry.family?.toUpperCase()} · {MODALITY_LABELS[entry.modality]}</div>
          </td>
          <td className="p-4 align-top text-zinc-600">{entry.priceLabel}</td>
          <td className="p-4 align-top tabular-nums">{historyPrice(entry.previous, entry.unit)}</td>
          <td className="p-4 align-top font-medium tabular-nums">{historyPrice(entry.current, entry.unit)}</td>
        </tr>)}
      </Table>
    </>}
  </>;
}
