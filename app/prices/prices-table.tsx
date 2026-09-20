'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { discountPercent, type PublicPrice } from '@/lib/dashboard/public-prices';

const FILTERS = ['Group', 'Vendor', 'Tags', 'Pricing Type', 'Endpoint Type'] as const;
type Filter = (typeof FILTERS)[number];
function values(row: PublicPrice, filter: Filter): string[] {
  switch (filter) {
    case 'Group':
      return [row.group];
    case 'Vendor':
      return [row.vendor];
    case 'Tags':
      return row.tags;
    case 'Pricing Type':
      return [row.pricingType];
    case 'Endpoint Type':
      return row.endpoints;
  }
}
const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 6 });

function Price({ value, list }: { value: number; list: number | null }) {
  const discount = discountPercent(value, list);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 tabular-nums">
      <span>{number(value)}</span>
      {list !== null && (
        <s className="text-xs text-zinc-400" aria-label={'Vendor list price ' + number(list)}>
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
      <rect x="1" y="1" width="30" height="30" rx="9" fill="none" stroke="currentColor" />
      <text x="16" y="21" textAnchor="middle" fontSize="15" fontWeight="600" fill="currentColor">
        {vendor.slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

export function PricesTable({ prices }: { prices: PublicPrice[] }) {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Partial<Record<Filter, string>>>({});
  const [ascending, setAscending] = useState(true);
  const [sort, setSort] = useState<'input' | 'output'>('input');
  const visible = useMemo(
    () =>
      prices
        .filter(
          (row) =>
            (row.model + ' ' + row.label + ' ' + row.vendor)
              .toLowerCase()
              .includes(search.toLowerCase()) &&
            FILTERS.every(
              (filter) => !filters[filter] || values(row, filter).includes(filters[filter]!),
            ),
        )
        .sort(
          (a, b) => (ascending ? 1 : -1) * (a[sort] - b[sort]) || a.model.localeCompare(b.model),
        ),
    [prices, search, filters, ascending, sort],
  );
  return (
    <div className="mt-8">
      <input
        type="search"
        aria-label="Search models"
        placeholder="Search models or vendors…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm sm:max-w-lg"
      />
      <div className="my-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => (
          <label
            key={filter}
            className="rounded-full border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600"
          >
            {filter}{' '}
            <select
              aria-label={filter}
              value={filters[filter] ?? ''}
              onChange={(e) => setFilters({ ...filters, [filter]: e.target.value })}
              className="max-w-40 bg-white font-medium text-zinc-900"
            >
              <option value="">All</option>
              {[...new Set(prices.flatMap((row) => values(row, filter)))].sort().map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        ))}
        <button
          onClick={() => {
            setFilters({});
            setSearch('');
          }}
          className="px-2 text-xs text-zinc-500 underline"
        >
          Clear filters
        </button>
      </div>
      <p aria-live="polite" className="mb-3 text-xs text-zinc-500">
        {visible.length} {visible.length === 1 ? 'model' : 'models'}
      </p>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[68rem] text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
            <tr>
              <th className="p-4">Model</th>
              <th className="p-4">Type</th>
              {(['input', 'output'] as const).map((key) => (
                <th
                  key={key}
                  className="p-4"
                  aria-sort={sort === key ? (ascending ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    onClick={() => {
                      setSort(key);
                      setAscending(sort === key ? !ascending : true);
                    }}
                    className="capitalize"
                  >
                    {key} price {sort === key ? (ascending ? '↑' : '↓') : '↕'}
                  </button>
                </th>
              ))}
              <th className="p-4">Cached</th>
              <th className="p-4">Vendor</th>
              <th className="p-4">Context</th>
              <th className="p-4">Endpoints</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {!visible.length && (
              <tr>
                <td colSpan={8} className="p-10 text-center text-zinc-500">
                  No models match these filters.
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr key={row.model}>
                <td className="p-4">
                  <div className="flex items-center gap-3">
                    <VendorIcon vendor={row.vendor} />
                    <div>
                      <p className="font-medium text-zinc-900">{row.model}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {row.sourceLabel} · ×{row.multiplier}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="p-4">
                  <span className="rounded bg-zinc-100 px-2 py-1 text-xs">
                    {row.pricingType === 'token' ? 'Token' : 'Request'}
                  </span>
                  <span className="mt-1 block text-xs text-zinc-500">
                    {row.pricingType === 'token' ? 'per Mtok' : 'per request'}
                  </span>
                  {row.pricingType === 'request' && (
                    <span className="mt-1 block text-xs text-zinc-500">Catalog only</span>
                  )}
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
                <td className="p-4">{row.vendor}</td>
                <td className="p-4 tabular-nums">
                  {row.contextWindow === null ? 'Unknown' : number(row.contextWindow)}
                </td>
                <td className="p-4">
                  {row.endpoints.length ? (
                    row.endpoints.map((endpoint) => (
                      <Link
                        key={endpoint}
                        href={
                          endpoint === 'openai' && row.pricingType === 'token'
                            ? '/docs#chat'
                            : '/docs#endpoint-types'
                        }
                        className="mb-1 block text-xs text-zinc-700 underline"
                      >
                        {endpoint}
                      </Link>
                    ))
                  ) : (
                    <span className="text-zinc-500">Unspecified</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
