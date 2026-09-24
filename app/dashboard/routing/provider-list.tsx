'use client';

import { useState } from 'react';
import { MODALITY_LABELS, type Modality } from '@/lib/ai/source-types';
import type { RoutingProvider } from '@/lib/dashboard/routing-catalog';
import { BillingDetails } from '@/app/prices/billing-details';
import { formatCredits, StatusBadge } from '../ui';

const PAGE_SIZE = 10;

function formatMultiplier(value: number) {
  return '×' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ProviderCard({ provider }: { provider: RoutingProvider }) {
  const [query, setQuery] = useState('');
  const [modality, setModality] = useState<Modality | ''>('');
  const [page, setPage] = useState(1);
  const multipliers = [...new Set(provider.models.map((model) => model.creditMultiplier))].sort((a, b) => a - b);
  const multiplierLabel = multipliers.length === 1
    ? formatMultiplier(multipliers[0]!)
    : multipliers.length > 1
      ? formatMultiplier(multipliers[0]!) + '–' + formatMultiplier(multipliers[multipliers.length - 1]!)
      : null;
  const normalized = query.trim().toLowerCase();
  const matches = provider.models.filter((model) =>
    (!modality || model.modality === modality) &&
    (!normalized || [model.label, model.publicModelId, model.family ?? ''].some((value) =>
      value.toLowerCase().includes(normalized))),
  );
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <details className="group rounded-xl border border-zinc-200 bg-white" data-provider={provider.id}>
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 rounded-xl p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="text-base font-semibold text-zinc-900">{provider.label}</h2>
            {multiplierLabel && <span className="rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium tabular-nums text-zinc-700">Price multiplier {multiplierLabel}</span>}
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-zinc-600">{provider.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <span className="rounded-full bg-zinc-100 px-2.5 py-1 font-medium text-zinc-700">
              {provider.models.length} configured {provider.models.length === 1 ? 'model' : 'models'}
            </span>
            {provider.modalities.map((kind) => <span key={kind} className="rounded-full border border-zinc-200 px-2.5 py-1">{MODALITY_LABELS[kind]}</span>)}
          </div>
        </div>
        <span className="mt-1 flex shrink-0 items-center gap-2 text-xs font-medium text-zinc-600">
          <span className="hidden sm:inline group-open:hidden">View models &amp; prices</span>
          <span className="hidden sm:group-open:inline">Hide models</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4 transition-transform group-open:rotate-180">
            <path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </summary>
      <div className="border-t border-zinc-200">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="block sm:w-80">
            <span className="sr-only">Search {provider.label} models</span>
            <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search models…" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm" />
          </label>
          <label>
            <span className="sr-only">Model type for {provider.label}</span>
            <select value={modality} onChange={(event) => { setModality(event.target.value as Modality | ''); setPage(1); }} className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm sm:w-auto">
              <option value="">All model types</option>
              {provider.modalities.map((kind) => <option key={kind} value={kind}>{MODALITY_LABELS[kind]}</option>)}
            </select>
          </label>
        </div>
        <p className="px-4 pb-3 text-xs leading-5 text-zinc-500">
          Prices in credits already include the listed multiplier. Token rates are per 1M tokens.
          Media prices are per job. “Up to” is the amount reserved; the actual charge may be lower.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[50rem] border-collapse text-left text-sm">
            <thead className="border-y border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Model</th>
                {['Multiplier', 'Input / 1M', 'Output / 1M', 'Cache / 1M', 'Per job'].map((heading) =>
                  <th key={heading} scope="col" className="whitespace-nowrap px-4 py-3 text-right font-medium">{heading}</th>,
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((model) => (
                <tr key={model.id}>
                  <td className="p-4 align-top">
                    <div className="font-medium text-zinc-900">{model.label}</div>
                    {model.label !== model.publicModelId && <div className="mt-1 break-all font-mono text-xs text-zinc-500">{model.publicModelId}</div>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <span>{model.family?.toUpperCase()} · {MODALITY_LABELS[model.modality]}</span>
                      <StatusBadge status={model.status} />
                    </div>
                    <BillingDetails policy={model.billingPolicy} multiplier={model.creditMultiplier} />
                  </td>
                  <td className="whitespace-nowrap p-4 text-right align-top font-medium tabular-nums text-zinc-900">
                    {formatMultiplier(model.creditMultiplier)}
                  </td>
                  {[model.inputCreditsPerMTok, model.outputCreditsPerMTok, model.cachedCreditsPerMTok].map((price, index) =>
                    <td key={index} className="p-4 text-right align-top tabular-nums text-zinc-700">{model.requestCredits === null ? formatCredits(price) : '—'}</td>,
                  )}
                  <td className="whitespace-nowrap p-4 text-right align-top tabular-nums text-zinc-700">
                    {model.requestCredits === null ? '—' :
                      (model.requestPriceKind === 'up_to' ? 'Up to ' : model.requestPriceKind === 'from' ? 'From ' : '') + formatCredits(model.requestCredits)}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="p-8 text-center text-zinc-500">No models match your search.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500">
          <span role="status">{matches.length ? (current - 1) * PAGE_SIZE + 1 : 0}–{Math.min(current * PAGE_SIZE, matches.length)} of {matches.length} models</span>
          {pages > 1 && <div className="flex items-center gap-3">
            <button type="button" disabled={current === 1} onClick={() => setPage(current - 1)} className="rounded border border-zinc-200 px-3 py-1.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">Previous</button>
            <span>{current} / {pages}</span>
            <button type="button" disabled={current === pages} onClick={() => setPage(current + 1)} className="rounded border border-zinc-200 px-3 py-1.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">Next</button>
          </div>}
        </div>
      </div>
    </details>
  );
}

export function ProviderList({ providers }: { providers: RoutingProvider[] }) {
  return <div className="space-y-4">
    {providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
    {!providers.length && <p className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">No providers are available on your plan yet.</p>}
  </div>;
}
