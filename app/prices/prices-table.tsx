"use client";

import Link from "next/link";
import { BillingDetails } from './billing-details';
import { MODALITY_LABELS } from '@/lib/ai/source-types';
import { useMemo, useState } from "react";
import {
  discountPercent,
  comparePublicPrices,
  type PriceSort,
  type PublicPrice,
} from "@/lib/dashboard/public-prices";
import {
  ALL,
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  clampPage,
  formatPageSize,
  pageCount,
  pageRange,
  pageSlice,
  type PageSize,
} from "@/lib/ui/pagination";

const FILTERS = [
  "Source",
  "Group",
  "Vendor",
  "Tags",
  "Pricing Type",
  "Endpoint Type",
] as const;
type Filter = (typeof FILTERS)[number];
function values(row: PublicPrice, filter: Filter): string[] {
  switch (filter) {
    case "Source":
      return [row.sourceLabel];
    case "Group":
      return [row.group];
    case "Vendor":
      return [row.vendor];
    case "Tags":
      return row.tags;
    case "Pricing Type":
      return [row.pricingType];
    case "Endpoint Type":
      return row.endpoints;
  }
}
const number = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 6 });

function Price({ value, list }: { value: number | null; list: number | null }) {
  if (value === null) return <span className="text-zinc-500" aria-label="Not applicable">—</span>;
  const discount = discountPercent(value, list);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 tabular-nums">
      <span>{number(value)}</span>
      {list !== null && list > value && (
        <s
          className="text-xs text-zinc-400"
          aria-label={"Reference list price " + number(list)}
        >
          {number(list)}
        </s>
      )}
      {discount !== null && (
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
          −{discount}%
        </span>
      )}
    </span>
  );
}

/** A monochrome vendor monogram avoids fetching third-party assets or trackers. */
function VendorIcon({ vendor }: { vendor: string }) {
  return (
    <svg
      role="img"
      aria-label={vendor}
      viewBox="0 0 32 32"
      className="h-8 w-8 shrink-0 text-zinc-700"
    >
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="9"
        fill="none"
        stroke="currentColor"
      />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontSize="15"
        fontWeight="600"
        fill="currentColor"
      >
        {vendor.slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

export function PricesTable({ prices }: { prices: PublicPrice[] }) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Partial<Record<Filter, string>>>({});
  const [ascending, setAscending] = useState(true);
  const [sort, setSort] = useState<PriceSort>("input");
  const [size, setSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  /**
   * Resizing or re-filtering the list should land the reader at the top of the
   * new result set, so every control that changes what is visible resets the
   * page itself. Clamping on render is the backstop, not the mechanism.
   */
  const resize = (next: PageSize) => {
    setSize(next);
    setPage(1);
  };
  const visible = useMemo(
    () =>
      prices
        .filter(
          (row) =>
            (row.model + " " + row.label + " " + row.vendor)
              .toLowerCase()
              .includes(search.toLowerCase()) &&
            FILTERS.every(
              (filter) =>
                !filters[filter] ||
                values(row, filter).includes(filters[filter]!),
            ),
        )
        .sort((a, b) => comparePublicPrices(a, b, sort, ascending)),
    [prices, search, filters, ascending, sort],
  );
  // Narrowing the list can strand the reader past the last page; clamping on
  // render brings them back to the last real page without an extra render pass.
  const current = clampPage(page, visible.length, size);
  // Stepping from the clamped page (not the raw state) keeps consecutive
  // clicks honest when the stored page is ahead of the real last page.
  const step = (delta: number) =>
    setPage((previous) =>
      clampPage(
        clampPage(previous, visible.length, size) + delta,
        visible.length,
        size,
      ),
    );
  const rows = pageSlice(visible, current, size);
  const pages = pageCount(visible.length, size);
  const { from, to } = pageRange(current, size, visible.length);
  const stepClass =
    "rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 enabled:hover:bg-zinc-50 disabled:text-zinc-300";
  return (
    <div className="mt-8">
      <input
        type="search"
        aria-label="Search models"
        placeholder="Search models or vendors…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm sm:max-w-lg"
      />
      <div className="my-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <label
            key={filter}
            className="rounded-full border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600"
          >
            {filter}{" "}
            <select
              aria-label={filter}
              value={filters[filter] ?? ""}
              onChange={(e) => {
                setFilters({ ...filters, [filter]: e.target.value });
                setPage(1);
              }}
              className="max-w-40 bg-white font-medium text-zinc-900"
            >
              <option value="">All</option>
              {[...new Set(prices.flatMap((row) => values(row, filter)))]
                .sort()
                .map((value) => (
                  <option key={value}>{value}</option>
                ))}
            </select>
          </label>
        ))}
        <button
          onClick={() => {
            setFilters({});
            setSearch("");
            setPage(1);
          }}
          className="px-2 text-xs text-zinc-500 underline"
        >
          Clear filters
        </button>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p aria-live="polite" className="text-xs text-zinc-500">
          Showing {from}–{to} of {visible.length}{" "}
          {visible.length === 1 ? "model" : "models"}
        </p>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Per page
          <select
            aria-label="Models per page"
            value={formatPageSize(size).toLowerCase()}
            onChange={(e) =>
              resize(
                e.target.value === ALL
                  ? ALL
                  : Number.parseInt(e.target.value, 10),
              )
            }
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1 font-medium text-zinc-900"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value={ALL}>All</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[74rem] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="p-4">Model</th>
              <th className="p-4">Type</th>
              {(["input", "output"] as const).map((key) => (
                <th
                  key={key}
                  className="p-4"
                  aria-sort={
                    sort === key
                      ? ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    onClick={() => {
                      setSort(key);
                      setAscending(sort === key ? !ascending : true);
                    }}
                    className="capitalize"
                  >
                    {key} / 1M {sort === key ? (ascending ? "↑" : "↓") : "↕"}
                  </button>
                </th>
              ))}
              <th className="p-4">Cache / 1M</th>
              <th className="p-4" aria-sort={sort === 'request' ? ascending ? 'ascending' : 'descending' : 'none'}>
                <button onClick={() => { setSort('request'); setAscending(sort === 'request' ? !ascending : true); }}>
                  Per job {sort === 'request' ? ascending ? '↑' : '↓' : '↕'}
                </button>
              </th>
              <th className="p-4">Vendor</th>
              <th className="p-4">Context</th>
              <th className="p-4">Endpoints</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {!rows.length && (
              <tr>
                <td colSpan={9} className="p-10 text-center text-zinc-500">
                  No models match these filters.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={JSON.stringify([row.model, row.providerId, row.modality])} data-model={row.model} data-provider={row.providerId}>
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <VendorIcon vendor={row.vendor} />
                    <div>
                      <p className="font-medium text-zinc-900">{row.model}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {row.sourceLabel} · ×{row.multiplier}
                      </p>
                      <BillingDetails policy={row.billingPolicy} multiplier={row.multiplier} />
                    </div>
                  </div>
                </td>
                <td className="p-4">
                  <span className="rounded bg-zinc-100 px-2 py-1 text-xs">
                    {MODALITY_LABELS[row.modality]}
                  </span>
                  <span className="mt-1 block text-xs text-zinc-500">
                    {row.pricingType === "token" ? "per 1M tokens" : "per job"}
                  </span>
                </td>
                <td className="p-4">
                  <Price value={row.input} list={row.listInput} />
                </td>
                <td className="p-4">
                  <Price value={row.output} list={row.listOutput} />
                </td>
                <td className="p-4">
                  <Price value={row.cached} list={row.listCached} />
                </td>
                <td className="p-4 tabular-nums">
                  {row.pricingType === 'token' ? <span className="text-zinc-500" aria-label="Not applicable">—</span> :
                    row.request === null ? <span className="text-zinc-500">Not configured</span> : <>
                      <span className="whitespace-nowrap">
                        {row.requestPriceKind === 'up_to' ? 'Up to ' : row.requestPriceKind === 'from' ? 'From ' : ''}
                        <Price value={row.request} list={row.requestPriceKind === 'up_to' ? null : row.listRequest} />
                      </span>
                      {row.requestPriceKind === 'up_to' && <span className="mt-1 block max-w-40 text-xs text-zinc-500">Reserved at start; actual cost may be lower.</span>}
                      {row.requestPriceKind === 'from' && <span className="mt-1 block text-xs text-zinc-500">Varies with image size.</span>}
                    </>}
                </td>
                <td className="p-4">{row.vendor}</td>
                <td className="p-4 tabular-nums">
                  {row.contextWindow === null
                    ? "Unknown"
                    : number(row.contextWindow)}
                </td>
                <td className="p-4">
                  {row.endpoints.length ? (
                    row.endpoints.map((endpoint) => (
                      <Link
                        key={endpoint}
                        href={
                          endpoint === "openai" && row.pricingType === "token"
                            ? "/docs#chat"
                            : row.pricingType === 'request' ? '/docs#media' : "/docs#endpoint-types"
                        }
                        className="mb-1 block text-xs text-zinc-700 underline"
                      >
                        {endpoint}
                      </Link>
                    ))
                  ) : row.pricingType === 'request' && row.modality !== 'chat' ? (
                    <Link href="/docs#media" className="text-xs text-zinc-700 underline">/v1/{row.modality === 'image' ? 'images' : 'videos'}</Link>
                  ) : (
                    <span className="text-zinc-500">Unspecified</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {size !== ALL && visible.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-zinc-500">
          <span className="tabular-nums">
            Page {current} / {pages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={current <= 1}
              className={stepClass}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={current >= pages}
              className={stepClass}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
