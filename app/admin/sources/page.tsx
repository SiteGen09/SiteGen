import { requireAdmin } from '@/lib/api/admin';
import { listSources } from '@/lib/ai/sources';
import { sql } from '@/lib/db';
import { Card, PageTitle } from '../_components/ui';
import { SourceForm } from './source-form';

export const dynamic = 'force-dynamic';

export default async function SourcesPage() {
  await requireAdmin();
  const [sources, counts] = await Promise.all([
    listSources(),
    sql.unsafe<{ source_id: string; count: number }[]>(
      'SELECT source_id, count(*)::int AS count FROM channels WHERE source_id IS NOT NULL GROUP BY source_id',
    ),
  ]);
  const countById = new Map(counts.map((row) => [row.source_id, row.count]));
  return (
    <>
      <PageTitle
        title="Sources"
        subtitle="One markup for every model on an upstream source. Repricing requires confirmation."
      />
      <div className="space-y-5">
        <Card>
          <details>
            <summary className="cursor-pointer">New source</summary>
            <div className="mt-4">
              <SourceForm />
            </div>
          </details>
        </Card>
        {sources.map((source) => (
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
      </div>
    </>
  );
}
