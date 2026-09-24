import type { ReactNode } from "react";
import Link from "next/link";

import {
  ALL,
  PAGE_SIZE_OPTIONS,
  clampPage,
  formatPageSize,
  pageCount,
  pageHref,
  pageRange,
  type PageSize,
} from "@/lib/ui/pagination";

/** Shared presentational pieces for the dashboard pages. Server-safe (no hooks). */

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold text-zinc-900">{title}</h1>
      {description !== undefined && (
        <p className="mt-1 text-sm text-zinc-500">{description}</p>
      )}
    </header>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white p-4 sm:p-5 ${className ?? ""}`.trimEnd()}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">
        {value}
      </p>
      {hint !== undefined && (
        <p className="mt-1 text-xs text-zinc-500">{hint}</p>
      )}
    </Card>
  );
}

/**
 * `minWidth` is the table's own floor inside the horizontal scroller: without
 * one, narrow viewports crush the columns instead of letting them scroll.
 */
export function Table({
  head,
  children,
  minWidth = "min-w-[34rem]",
}: {
  head: readonly string[];
  children: ReactNode;
  minWidth?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
      <table className={`w-full ${minWidth} border-collapse text-left text-sm`}>
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50">
            {head.map((cell) => (
              <th
                key={cell}
                scope="col"
                className="whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-8 text-center text-sm text-zinc-500"
      >
        {children}
      </td>
    </tr>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  ok: "bg-emerald-50 text-emerald-700",
  revoked: "bg-zinc-100 text-zinc-600",
  inactive: "bg-zinc-100 text-zinc-600",
  failed: "bg-red-50 text-red-700",
  rejected: "bg-amber-50 text-amber-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-600"
      }`}
    >
      {status}
    </span>
  );
}

const DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "UTC",
});

/** UTC-formatted timestamp so server render and client hydration agree. */
export function formatTimestamp(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : `${DATE_TIME.format(parsed)} UTC`;
}

export function formatCredits(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Paging controls for the dashboard tables. Rendered as links rather than a
 * form so the control works without JavaScript and each page stays shareable.
 */
export function Pager({
  basePath,
  page,
  pageSize,
  total,
  query,
  label = "rows",
  params,
}: {
  basePath: string;
  page: number;
  pageSize: PageSize;
  total: number;
  query?: Readonly<Record<string, string | number | undefined>>;
  label?: string;
  params?: { page?: string; size?: string };
}) {
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  const { from, to } = pageRange(current, pageSize, total);
  const href = (nextPage: number, nextSize: PageSize) =>
    pageHref(basePath, nextPage, nextSize, query, params);
  const stepClass =
    "rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50";
  const stepMutedClass =
    "rounded-md border border-zinc-100 px-3 py-1.5 text-sm text-zinc-300";
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 text-sm text-zinc-500">
      <div className="flex flex-wrap items-center gap-3">
        <span className="tabular-nums">
          {from}–{to} of {total.toLocaleString("en-US")} {label}
        </span>
        <span className="flex items-center gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Show
          </span>
          {[...PAGE_SIZE_OPTIONS, ALL].map((option) => {
            const active = option === pageSize;
            return (
              <Link
                key={option}
                href={href(1, option)}
                aria-current={active ? "page" : undefined}
                className={`rounded px-1.5 py-0.5 text-xs ${
                  active
                    ? "bg-zinc-900 font-medium text-white"
                    : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                }`}
              >
                {formatPageSize(option)}
              </Link>
            );
          })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {current > 1 ? (
          <Link href={href(current - 1, pageSize)} className={stepClass}>
            Previous
          </Link>
        ) : (
          <span className={stepMutedClass}>Previous</span>
        )}
        <span className="tabular-nums text-zinc-400">
          Page {current} / {pages}
        </span>
        {current < pages ? (
          <Link href={href(current + 1, pageSize)} className={stepClass}>
            Next
          </Link>
        ) : (
          <span className={stepMutedClass}>Next</span>
        )}
      </div>
    </div>
  );
}
