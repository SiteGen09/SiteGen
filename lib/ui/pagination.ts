/**
 * One pagination contract for every list in the app — admin tables, dashboard
 * tables and the public price list alike.
 *
 * Page size is a reader's choice, not a per-page constant: short pages (5, 10)
 * keep a dense admin table scannable, while "All" is the only honest option
 * when someone is scanning for one row or copying the whole set out. The choice
 * travels in the query string so a paginated view stays linkable and survives a
 * server action's revalidation.
 */

export const PAGE_SIZE_OPTIONS = [5, 10, 25, 50, 100] as const;

export const ALL = "all" as const;

/** A resolved page size: a positive row count, or every row. */
export type PageSize = number | typeof ALL;

export const DEFAULT_PAGE_SIZE = 5;

/** The largest size a query string may ask for short of "all". */
export const MAX_PAGE_SIZE = 100;

/**
 * "All" still has to become a LIMIT for database-backed pages. The cap is far
 * above any realistic table here and exists only so a hostile or corrupt query
 * string cannot ask the database for an unbounded scan.
 */
export const ALL_LIMIT = 100_000;

/** Query parameter names, kept in one place so links and readers agree. */
export const PAGE_PARAM = "page";
export const SIZE_PARAM = "size";

export function parsePageSize(
  raw: string | undefined,
  fallback: PageSize = DEFAULT_PAGE_SIZE,
): PageSize {
  if (raw === undefined || raw === "") return fallback;
  if (raw === ALL) return ALL;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  // Anything outside the offered options is clamped rather than honoured, so a
  // hand-edited `?size=` cannot turn a page into a full-table render.
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function parsePage(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function pageCount(total: number, size: PageSize): number {
  if (size === ALL) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/** Keeps a stale `?page=` (a deleted row, a narrowed filter) inside the range. */
export function clampPage(page: number, total: number, size: PageSize): number {
  return Math.min(Math.max(1, page), pageCount(total, size));
}

export function pageSlice<T>(
  rows: readonly T[],
  page: number,
  size: PageSize,
): T[] {
  if (size === ALL) return [...rows];
  const safePage = clampPage(page, rows.length, size);
  const start = (safePage - 1) * size;
  return rows.slice(start, start + size);
}

/** LIMIT/OFFSET for lists paginated in the database instead of in memory. */
export function pageQuery(
  page: number,
  size: PageSize,
): { limit: number; offset: number } {
  if (size === ALL) return { limit: ALL_LIMIT, offset: 0 };
  return { limit: size, offset: (Math.max(1, page) - 1) * size };
}

/** The 1-based row range this page covers, for the "1–10 of 42" readout. */
export function pageRange(
  page: number,
  size: PageSize,
  total: number,
): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  if (size === ALL) return { from: 1, to: total };
  const safePage = clampPage(page, total, size);
  return {
    from: (safePage - 1) * size + 1,
    to: Math.min(safePage * size, total),
  };
}

export function formatPageSize(size: PageSize): string {
  return size === ALL ? "All" : String(size);
}

/**
 * Builds a link that changes only the paging parameters: every other filter the
 * page is carrying (dates, status, tab) stays on the URL.
 */
export function pageHref(
  basePath: string,
  page: number,
  size: PageSize,
  extra: Readonly<Record<string, string | number | undefined>> = {},
  params: { page?: string; size?: string } = {},
): string {
  // Two lists on one page (source cards and source usage, say) each need their
  // own parameter names, hence the override.
  const pageParam = params.page ?? PAGE_PARAM;
  const sizeParam = params.size ?? SIZE_PARAM;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === "") continue;
    if (key === pageParam || key === sizeParam) continue;
    search.set(key, String(value));
  }
  if (page > 1) search.set(pageParam, String(page));
  if (size !== DEFAULT_PAGE_SIZE)
    search.set(sizeParam, formatPageSize(size).toLowerCase());
  const query = search.toString();
  return query === "" ? basePath : `${basePath}?${query}`;
}
