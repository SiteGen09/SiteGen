import { listChannelInfo, listLedger, listUsageEvents } from '@/lib/dashboard/queries';
import { connection } from 'next/server';
import UsageDashboard from './usage-dashboard';

export const metadata = { title: 'Usage & Analytics - sitegen' };

const USAGE_LIMIT = 5000;
const LEDGER_PAGE_SIZE = 50;
const STATUS_OPTIONS = ['ok', 'failed', 'rejected'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first === '' ? undefined : first;
}

function asDate(value: string | undefined): string | undefined {
  if (value === undefined || !DATE_PATTERN.test(value)) return undefined;

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

function asStatus(value: string | undefined): string | undefined {
  return value !== undefined && (STATUS_OPTIONS as readonly string[]).includes(value)
    ? value
    : undefined;
}

function asCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asTab(value: string | undefined): 'overview' | 'details' {
  return value === 'details' ? 'details' : 'overview';
}

function currentTimestamp(): number {
  return Date.now();
}

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const params = await searchParams;
  const from = asDate(one(params.from));
  const to = asDate(one(params.to));
  const status = asStatus(one(params.status));
  const cursor = asCursor(one(params.cursor));
  const initialTab = asTab(one(params.tab));

  // The client owns the compact period controls, so provide enough history for
  // their ranges while keeping this screen's request payload bounded.
  const [events, ledger] = await Promise.all([
    listUsageEvents({ from, to, status, limit: USAGE_LIMIT }),
    // One extra row tells us whether another page exists without a count query.
    listLedger({ limit: LEDGER_PAGE_SIZE + 1, beforeId: cursor }),
  ]);

  const ledgerPage = ledger.slice(0, LEDGER_PAGE_SIZE);
  const lastEntry = ledgerPage.at(-1);
  const nextCursor = ledger.length > LEDGER_PAGE_SIZE && lastEntry !== undefined ? lastEntry.id : null;
  const channelIds = [
    ...events.map((event) => event.channel_id),
    ...ledgerPage.flatMap((entry) => (entry.channel_id === null ? [] : [entry.channel_id])),
  ];
  const channels = await listChannelInfo(channelIds);

  const filterQuery = new URLSearchParams();
  filterQuery.set('tab', 'details');
  if (from !== undefined) filterQuery.set('from', from);
  if (to !== undefined) filterQuery.set('to', to);
  if (status !== undefined) filterQuery.set('status', status);

  function ledgerHref(nextValue: number | null): string {
    const query = new URLSearchParams(filterQuery);
    if (nextValue !== null) query.set('cursor', String(nextValue));
    return `/dashboard/usage?${query.toString()}`;
  }

  return (
    <UsageDashboard
      key={initialTab}
      events={events}
      ledgerPage={ledgerPage}
      channels={channels}
      from={from}
      to={to}
      status={status}
      cursor={cursor}
      nextCursor={nextCursor}
      ledgerNewestHref={ledgerHref(null)}
      ledgerOlderHref={nextCursor === null ? null : ledgerHref(nextCursor)}
      renderedAt={currentTimestamp()}
      initialTab={initialTab}
    />
  );
}
