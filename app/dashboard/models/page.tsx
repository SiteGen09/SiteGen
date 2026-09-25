import Link from 'next/link';
import { BillingDetails } from '@/app/prices/billing-details';
import { getPlans, type PlanKey } from '@/lib/billing/plans';
import { getEntitlement, listModelCatalog, type ModelCatalogEntry } from '@/lib/dashboard/queries';
import { filterModelCatalog, type ModelCatalogFilters } from '@/lib/dashboard/model-catalog-filters';
import { FAMILIES, FAMILY_LABELS, MODALITIES } from '@/lib/ai/source-types';
import { requireUser } from '@/lib/dashboard/session';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { Card, EmptyRow, PageHeader, Pager, StatusBadge, Table, formatCredits } from '../ui';

export const metadata = { title: 'Models — sitegen' };

type SearchParams = Record<string, string | string[] | undefined>;

function searchValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const HEAD = [
  'Model',
  'Provider',
  'Source',
  'Status',
  'Input / Mtok',
  'Output / Mtok',
  'Cached / Mtok',
  'Plan',
] as const;

/**
 * The full catalogue is shown to everyone — plan is a column, not a filter, so
 * the page answers "what does this gateway serve?" rather than "what may I
 * call today?". Rows the current plan already covers are marked; the rest name
 * the tier that unlocks them.
 */
function planNote(entry: ModelCatalogEntry, planKey: PlanKey): string {
  const plans = getPlans();
  if (plans[planKey].rank >= plans[entry.minPlan].rank) return 'Included';
  return `${plans[entry.minPlan].label} and up`;
}

function credits(entry: ModelCatalogEntry, value: number): string {
  return entry.isByok ? 'Your key' : formatCredits(value);
}

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const [sp, entitlement, models] = await Promise.all([
    searchParams,
    getEntitlement(user.id),
    listModelCatalog(),
  ]);
  const plans = getPlans();
  const planLabel = plans[entitlement.planKey].label;
  const size = parsePageSize(searchValue(sp.size));
  const search = {
    q: searchValue(sp.q), status: searchValue(sp.status), family: searchValue(sp.family),
    modality: searchValue(sp.modality), pricing: searchValue(sp.pricing), source: searchValue(sp.source),
    plan: searchValue(sp.plan), planAccess: searchValue(sp.planAccess), access: searchValue(sp.access),
    maxInput: searchValue(sp.maxInput), maxOutput: searchValue(sp.maxOutput),
    maxCached: searchValue(sp.maxCached), maxRequest: searchValue(sp.maxRequest),
    page: searchValue(sp.page),
  };
  const filters: ModelCatalogFilters = {
    query: search.q, status: search.status, family: search.family, modality: search.modality, pricing: search.pricing,
    source: search.source, plan: search.plan,
    planAccess: search.planAccess === 'included' || search.planAccess === 'upgrade' ? search.planAccess : undefined,
    availablePlanRank: plans[entitlement.planKey].rank,
    access: search.access,
    maxInput: search.maxInput !== undefined && search.maxInput.trim() !== '' && Number.isFinite(Number(search.maxInput)) && Number(search.maxInput) >= 0 ? Number(search.maxInput) : undefined,
    maxOutput: search.maxOutput !== undefined && search.maxOutput.trim() !== '' && Number.isFinite(Number(search.maxOutput)) && Number(search.maxOutput) >= 0 ? Number(search.maxOutput) : undefined,
    maxCached: search.maxCached !== undefined && search.maxCached.trim() !== '' && Number.isFinite(Number(search.maxCached)) && Number(search.maxCached) >= 0 ? Number(search.maxCached) : undefined,
    maxRequest: search.maxRequest !== undefined && search.maxRequest.trim() !== '' && Number.isFinite(Number(search.maxRequest)) && Number(search.maxRequest) >= 0 ? Number(search.maxRequest) : undefined,
  };
  const filtered = filterModelCatalog(models, filters);
  const page = clampPage(parsePage(search.page), filtered.length, size);
  const visible = pageSlice(filtered, page, size);
  const query = {
    q: search.q, status: filters.status, family: filters.family, modality: filters.modality, pricing: filters.pricing,
    source: filters.source, plan: filters.plan, planAccess: filters.planAccess, access: filters.access,
    maxInput: filters.maxInput, maxOutput: filters.maxOutput, maxCached: filters.maxCached,
    maxRequest: filters.maxRequest,
  };

  return (
    <>
      <PageHeader
        title="Models"
        description={`Every model this gateway serves. Pass the model name as "model" to POST /v1/chat/completions.`}
      />

      <Card className="mb-6">
        <p className="text-sm text-zinc-700">
          Prices are credits per million tokens, markup included. Cached input is billed at the
          cached rate. Models marked BYOK bill your own provider key instead of credits — add one
          under{' '}
          <Link href="/dashboard/credentials" className="underline hover:text-zinc-900">
            Credentials
          </Link>
          . Live serving health is on{' '}
          <Link href="/dashboard/status" className="underline hover:text-zinc-900">
            Model status
          </Link>
          .
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          You are on the <span className="font-medium text-zinc-700">{planLabel}</span> plan. The
          Plan column shows which tier each model needs —{' '}
          <Link href="/dashboard/billing" className="underline hover:text-zinc-700">
            change plan
          </Link>
          .
        </p>
      </Card>

      <Card className="mb-4">
        <form action="/dashboard/models" method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-zinc-600 sm:col-span-2">
            Search all model details
            <input type="search" name="q" defaultValue={search.q ?? ''} placeholder="Model, provider, family, source…" className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900" />
          </label>
          <input type="hidden" name="size" value={String(size)} />
          <label className="text-xs font-medium text-zinc-600">
            Route status
            <select name="status" defaultValue={filters.status ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All statuses</option><option value="active">Active</option><option value="degraded">Degraded</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Model family
            <select name="family" defaultValue={filters.family ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All families</option>{FAMILIES.map((family) => <option key={family} value={family}>{FAMILY_LABELS[family]}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Capability
            <select name="modality" defaultValue={filters.modality ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All capabilities</option>{MODALITIES.map((modality) => <option key={modality} value={modality}>{modality[0]!.toUpperCase() + modality.slice(1)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Pricing unit
            <select name="pricing" defaultValue={filters.pricing ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All pricing</option><option value="token">Per token</option><option value="request">Per job</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Source
            <select name="source" defaultValue={filters.source ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All sources</option>{[...new Set(models.map((model) => model.sourceLabel))].sort().map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Required plan
            <select name="plan" defaultValue={filters.plan ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All plans</option>{(['free', 'starter', 'pro', 'max'] as const).map((key) => <option key={key} value={key}>Requires {plans[key].label}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Access on your plan ({planLabel})
            <select name="planAccess" defaultValue={filters.planAccess ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">All models</option><option value="included">Included in my plan</option><option value="upgrade">Requires a higher plan</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Billing
            <select name="access" defaultValue={filters.access ?? ''} className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900">
              <option value="">Credits or BYOK</option><option value="credits">Credits</option><option value="byok">Bring your own key</option>
            </select>
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Max input price · credits / 1M tokens
            <input type="number" name="maxInput" min="0" step="any" defaultValue={filters.maxInput} placeholder="Any price" className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900" />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Max output price · credits / 1M tokens
            <input type="number" name="maxOutput" min="0" step="any" defaultValue={filters.maxOutput} placeholder="Any price" className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900" />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Max cached price · credits / 1M tokens
            <input type="number" name="maxCached" min="0" step="any" defaultValue={filters.maxCached} placeholder="Any price" className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900" />
          </label>
          <label className="text-xs font-medium text-zinc-600">
            Max job price · credits
            <input type="number" name="maxRequest" min="0" step="any" defaultValue={filters.maxRequest} placeholder="Any price" className="mt-1 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-normal text-zinc-900" />
          </label>
          <div className="flex items-end gap-3 sm:col-span-2 lg:col-span-4">
            <button type="submit" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">Apply filters</button>
            <Link href="/dashboard/models" className="px-2 py-2 text-sm text-zinc-600 underline">Clear all</Link>
          </div>
        </form>
      </Card>

      <Table head={HEAD} minWidth="min-w-[52rem]">
        {visible.length === 0 ? (
          <EmptyRow colSpan={HEAD.length}>{models.length === 0 ? 'No models are configured yet.' : 'No models match these filters.'}</EmptyRow>
        ) : (
          visible.map((model) => (
            <tr key={model.id}>
              <td className="px-4 py-2.5">
                <span className="font-mono text-xs text-zinc-900">{model.publicModelId}</span>
                <span className="mt-0.5 block text-xs text-zinc-500">{model.label}</span>
                <BillingDetails policy={model.billingPolicy} multiplier={model.creditMultiplier} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {model.routingProvider?.label ?? 'Provider'}
              </td>
              <td className="px-4 py-2.5 text-zinc-600">{model.sourceLabel} · ×{model.creditMultiplier}</td>
              <td className="px-4 py-2.5">
                <StatusBadge status={model.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {model.requestCredits === null ? credits(model, model.inputCreditsPerMTok) : credits(model, model.requestCredits) + ' / job'}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {credits(model, model.outputCreditsPerMTok)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-zinc-600">
                {credits(model, model.cachedCreditsPerMTok)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                {planNote(model, entitlement.planKey)}
              </td>
            </tr>
          ))
        )}
      </Table>
      <Pager
        basePath="/dashboard/models"
        page={page}
        pageSize={size}
        total={filtered.length}
        query={query}
        label="models"
      />
    </>
  );
}
