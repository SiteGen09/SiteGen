import { FAMILIES, listSources, loadRoutingPreferences } from '@/lib/ai/sources';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { getBalance, getEntitlement, listModelCatalog } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { Card, PageHeader, Stat, Table, EmptyRow, formatCredits } from '../ui';
import { SourcePicker } from './source-picker';

export const metadata = { title: 'Routing — sitegen' };

export default async function RoutingPage() {
  const user = await requireUser();
  const [balance, entitlement, sources, preferences, models] = await Promise.all([
    getBalance(),
    getEntitlement(user.id),
    listSources(),
    loadRoutingPreferences(user.id),
    listModelCatalog(),
  ]);
  return (
    <>
      <PageHeader
        title="Routing"
        description="Choose a source for each model family. Your source sets the credit multiplier."
      />
      <Stat label="Available credits" value={formatCredits(balance)} />
      <div className="my-6 grid gap-4 lg:grid-cols-3">
        {FAMILIES.map((family) => {
          const eligible = sources.filter(
            (s) =>
              s.family === family &&
              s.status !== 'off' &&
              planMeetsMinimum(entitlement.planKey, s.min_plan),
          );
          const selected =
            eligible.find((s) => s.id === preferences.get(family)) ??
            eligible.find((s) => s.is_default);
          return (
            <SourcePicker
              key={family}
              family={family}
              sources={eligible}
              selected={selected?.id ?? ''}
            />
          );
        })}
      </div>
      <Card>
        <p className="text-sm text-zinc-600">
          If your source does not serve a model, we use its family default, then another eligible
          source. Availability fallbacks can use another source and are billed at that source’s
          multiplier.
        </p>
      </Card>
      {FAMILIES.map((family) => {
        const rows = models.filter(
          (model) =>
            model.family === family && planMeetsMinimum(entitlement.planKey, model.minPlan),
        );
        const active =
          sources.find(
            (s) =>
              s.id === preferences.get(family) &&
              s.status !== 'off' &&
              planMeetsMinimum(entitlement.planKey, s.min_plan),
          ) ??
          sources.find(
            (s) =>
              s.family === family &&
              s.is_default &&
              s.status !== 'off' &&
              planMeetsMinimum(entitlement.planKey, s.min_plan),
          );
        return (
          <section key={family} className="mt-6">
            <h2 className="mb-3 text-lg font-semibold text-zinc-900">{family.toUpperCase()}</h2>
            <Table head={['Model', 'Source', 'Description', 'Multiplier']}>
              {!rows.length && (
                <EmptyRow colSpan={4}>No models available for this family.</EmptyRow>
              )}
              {rows.map((model) => (
                <tr key={model.id}>
                  <td className="p-4">
                    {model.label}
                    <span className="block text-xs text-zinc-500">{model.publicModelId}</span>
                  </td>
                  <td className="p-4">
                    {model.sourceLabel}{' '}
                    {active?.id === model.sourceId && (
                      <span className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                        Active source
                      </span>
                    )}
                  </td>
                  <td className="p-4 text-zinc-600">{model.sourceDescription || '—'}</td>
                  <td className="p-4">×{model.creditMultiplier}</td>
                </tr>
              ))}
            </Table>
          </section>
        );
      })}
    </>
  );
}
