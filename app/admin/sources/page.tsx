import { requireAdmin } from '@/lib/api/admin';
import { usageBySource24h } from '@/lib/admin/metrics';
import { listSources } from '@/lib/ai/sources';
import { sql } from '@/lib/db';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';
import { Card, PageTitle, Pager } from '../_components/ui';
import { SourceForm } from './source-form';
import { SourceUsageTable } from './usage-table';

export const dynamic = 'force-dynamic';

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string; upage?: string; usize?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [sources, counts, usage] = await Promise.all([
    listSources(),
    sql.unsafe<{ source_id: string; count: number }[]>(
      'SELECT source_id, count(*)::int AS count FROM channels WHERE source_id IS NOT NULL GROUP BY source_id',
    ),
    usageBySource24h(),
  ]);
  const countById = new Map(counts.map((row) => [row.source_id, row.count]));
  // Two independent lists on one page, so each carries its own parameters.
  const size = parsePageSize(sp.size);
  const page = clampPage(parsePage(sp.page), sources.length, size);
  const visibleSources = pageSlice(sources, page, size);
  return (
    <>
      <PageTitle
        title="Sources"
        subtitle="One markup for every model on an upstream source. Repricing requires confirmation."
      />
      <div className="space-y-5">
        <SourceUsageTable
          rows={usage}
          page={parsePage(sp.upage)}
          size={parsePageSize(sp.usize)}
          query={{ page: sp.page, size: sp.size }}
        />
        <Card>
          <details>
            <summary className="cursor-pointer">New source</summary>
            <div className="mt-4">
              <SourceForm />
            </div>
          </details>
        </Card>
        {visibleSources.map((source) => (
          <Card key={source.id}>
            <details>
              <summary className="cursor-pointer font-medium">
                {source.label} · {source.family} · ×{source.credit_multiplier} · {source.status}
                {source.is_default ? ' · Default' : ''} · {countById.get(source.id) ?? 0} channels
              </summary>
              <div className="mt-4">
                <SourceForm source={source} count={countById.get(source.id) ?? 0} />
              </div>
            </details>
          </Card>
        ))}
        <Pager
          basePath="/admin/sources"
          page={page}
          pageSize={size}
          total={sources.length}
          label="sources"
          query={{ upage: sp.upage, usize: sp.usize }}
        />
      </div>
    </>
  );
}
