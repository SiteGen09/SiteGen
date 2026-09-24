import Link from 'next/link';
import { BillingDetails } from '@/app/prices/billing-details';
import { getPlans, type PlanKey } from '@/lib/billing/plans';
import { getEntitlement, listModelCatalog, type ModelCatalogEntry } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { Card, EmptyRow, PageHeader, Pager, StatusBadge, Table, formatCredits } from '../ui';

export const metadata = { title: 'Models — sitegen' };

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
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  const user = await requireUser();
  const [sp, entitlement, models] = await Promise.all([
    searchParams,
    getEntitlement(user.id),
    listModelCatalog(),
  ]);
  const plans = getPlans();
  const planLabel = plans[entitlement.planKey].label;
  const size = parsePageSize(sp.size);
  const page = clampPage(parsePage(sp.page), models.length, size);
  const visible = pageSlice(models, page, size);

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
          You are on the <span className="font-medium text-zinc-700">{planLabel}</span> plan, capped
          at{' '}
          <span className="tabular-nums">
            {formatCredits(plans[entitlement.planKey].maxOutputTokens)}
          </span>{' '}
          output tokens per request. The Plan column shows which tier each model needs —{' '}
          <Link href="/dashboard/billing" className="underline hover:text-zinc-700">
            change plan
          </Link>
          .
        </p>
      </Card>

      <Table head={HEAD} minWidth="min-w-[52rem]">
        {visible.length === 0 ? (
          <EmptyRow colSpan={HEAD.length}>No models are configured yet.</EmptyRow>
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
        total={models.length}
        label="models"
      />
    </>
  );
}
