import type { ReactNode } from 'react';
import Link from 'next/link';

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-50">{title}</h1>
      {subtitle !== undefined && <p className="mt-1 text-sm text-zinc-400">{subtitle}</p>}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900">
      {title !== undefined && (
        <h2 className="border-b border-zinc-800 px-3 py-3 text-sm font-medium text-zinc-200 sm:px-4">
          {title}
        </h2>
      )}
      <div className="p-3 sm:p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'alert' }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${
          tone === 'alert' ? 'text-rose-400' : 'text-zinc-50'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  active: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  ok: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  degraded: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  off: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
  revoked: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  inactive: 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30',
};

export function Badge({ value }: { value: string }) {
  const tone = STATUS_TONES[value] ?? 'bg-zinc-500/15 text-zinc-300 ring-zinc-500/30';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {value}
    </span>
  );
}

export function Th({ children }: { children: ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">
      {children}
    </th>
  );
}

export function Td({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2 align-top text-zinc-200">{children}</td>;
}

export function EmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-zinc-500">
        {label}
      </td>
    </tr>
  );
}

export function Pager({
  basePath,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const linkClass =
    'rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800';
  const mutedClass = 'rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-600';
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-zinc-400">
      <span>
        {from}–{to} of {total.toLocaleString()}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {page > 1 ? (
          <Link href={`${basePath}?page=${page - 1}`} className={linkClass}>
            Previous
          </Link>
        ) : (
          <span className={mutedClass}>Previous</span>
        )}
        <span className="text-zinc-500">
          Page {page} / {pages}
        </span>
        {page < pages ? (
          <Link href={`${basePath}?page=${page + 1}`} className={linkClass}>
            Next
          </Link>
        ) : (
          <span className={mutedClass}>Next</span>
        )}
      </div>
    </div>
  );
}
