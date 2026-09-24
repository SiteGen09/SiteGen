import { requireAdmin } from '@/lib/api/admin';
import Link from 'next/link';
import { sql } from '@/lib/db';
import { usersPage } from '@/lib/admin/metrics';
import { clampPage, pageQuery, parsePage, parsePageSize } from '@/lib/ui/pagination';

import { LiveRefresh } from '../_components/live-refresh';
import { Badge, Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';
import { GrantForm } from './_components/grant-form';
import { SuspendForm } from './_components/suspend-form';

export const dynamic = 'force-dynamic';

const COLS = 12;

function renderTime(): string {
  return new Date().toISOString();
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const size = parsePageSize(sp.size);
  const requested = parsePage(sp.page);
  const first = pageQuery(requested, size);
  const { users, total } = await usersPage(first.limit, first.offset);
  // A stale `?page=` past the end would render an empty table. Re-query the
  // last real page instead, so the rows and the pager always agree.
  const page = clampPage(requested, total, size);
  let rows = users;
  if (page !== requested) {
    const corrected = pageQuery(page, size);
    rows = (await usersPage(corrected.limit, corrected.offset)).users;
  }

  const holds = rows.length ? await sql`SELECT id FROM profiles WHERE id IN ${sql(rows.map(row => row.id))} AND billing_hold=true` : [];
  const frozenUsers = new Set(holds.map(row => row.id));
  return (
    <>
      <PageTitle title="Users" subtitle="Profiles, entitlements, credit consumption and manual credit grants." />
      <LiveRefresh renderedAt={renderTime()} />

      <Card title="All users">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[78rem] text-sm">
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Plan</Th>
                <Th>Access</Th>
                <Th>Subscription</Th>
                <Th>Period end</Th>
                <Th>Balance</Th>
                <Th>Used 30d</Th>
                <Th>Last request</Th>
                <Th>Strikes 24h</Th>
                <Th>Grant credits</Th>
                <Th>Suspend</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.length === 0 ? (
                <EmptyRow colSpan={COLS} label="No users." />
              ) : (
                rows.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      <Link href={'/admin/users/' + u.id} className="font-medium text-zinc-100 underline underline-offset-4">{u.email}</Link>
                      <div className="font-mono text-xs text-zinc-500">{u.id}</div>
                      <Link className="mr-3 text-xs underline" href={'/admin/users/' + u.id}>Usage &amp; credits</Link>
                      <Link className="text-xs underline" href={'/admin/orders?user='+u.id}>Order history</Link>
                    </Td>
                    <Td>
                      <Badge value={u.role} />
                    </Td>
                    <Td>{u.plan_key ?? '—'}</Td>
                    <Td>{u.status === 'active' ? '—' : <Badge value={u.status} />}{frozenUsers.has(u.id) && <Link href="/admin/disputes" className="block text-xs text-amber-400 underline">Billing freeze</Link>}</Td>
                    <Td>
                      {u.entitlement_status === null ? '—' : <Badge value={u.entitlement_status} />}
                    </Td>
                    <Td>
                      <span className="text-xs text-zinc-500">
                        {u.current_period_end === null
                          ? '—'
                          : u.current_period_end.toLocaleDateString()}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={`font-semibold ${u.balance < 0 ? 'text-rose-400' : 'text-zinc-100'}`}
                      >
                        {u.balance.toLocaleString()}
                      </span>
                    </Td>
                    <Td>{u.credits_30d.toLocaleString()}</Td>
                    <Td>
                      <span className="whitespace-nowrap text-xs text-zinc-500">
                        {u.last_used_at === null
                          ? '—'
                          : u.last_used_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={
                          u.strikes_24h > 0 ? 'font-semibold text-amber-400' : 'text-zinc-500'
                        }
                      >
                        {u.strikes_24h}
                      </span>
                    </Td>
                    <Td>
                      <GrantForm userId={u.id} />
                    </Td>
                    <Td>
                      <SuspendForm userId={u.id} suspended={u.status === 'suspended'} />
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager basePath="/admin/users" page={page} pageSize={size} total={total} label="users" />
      </Card>
    </>
  );
}
