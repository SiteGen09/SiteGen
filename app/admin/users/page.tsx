import { requireAdmin } from '@/lib/api/admin';
import { usersPage } from '@/lib/admin/metrics';

import { Badge, Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';
import { GrantForm } from './_components/grant-form';
import { SuspendForm } from './_components/suspend-form';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const COLS = 10;

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const { users, total } = await usersPage(PAGE_SIZE, (page - 1) * PAGE_SIZE);

  return (
    <>
      <PageTitle title="Users" subtitle="Profiles, entitlements and manual credit grants." />

      <Card title="All users">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[68rem] text-sm">
            <thead>
              <tr>
                <Th>User</Th>
                <Th>Role</Th>
                <Th>Plan</Th>
                <Th>Access</Th>
                <Th>Subscription</Th>
                <Th>Period end</Th>
                <Th>Balance</Th>
                <Th>Strikes 24h</Th>
                <Th>Grant credits</Th>
                <Th>Suspend</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {users.length === 0 ? (
                <EmptyRow colSpan={COLS} label="No users." />
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      <div className="font-medium text-zinc-100">{u.email}</div>
                      <div className="font-mono text-xs text-zinc-500">{u.id}</div>
                    </Td>
                    <Td>
                      <Badge value={u.role} />
                    </Td>
                    <Td>{u.plan_key ?? '—'}</Td>
                    <Td>{u.status === 'active' ? '—' : <Badge value={u.status} />}</Td>
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
        <Pager basePath="/admin/users" page={page} pageSize={PAGE_SIZE} total={total} />
      </Card>
    </>
  );
}