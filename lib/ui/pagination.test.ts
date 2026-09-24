import { describe, expect, it } from 'vitest';

import {
  ALL,
  ALL_LIMIT,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPage,
  pageCount,
  pageHref,
  pageQuery,
  pageRange,
  pageSlice,
  parsePage,
  parsePageSize,
} from './pagination';

const rows = Array.from({ length: 23 }, (_, index) => index);

describe('parsePageSize', () => {
  it('falls back when the parameter is missing or junk', () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize('')).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize('banana')).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize('0')).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize('-5')).toBe(DEFAULT_PAGE_SIZE);
  });

  it('honours the offered sizes and "all"', () => {
    expect(parsePageSize('5')).toBe(5);
    expect(parsePageSize('50')).toBe(50);
    expect(parsePageSize(ALL)).toBe(ALL);
  });

  it('clamps a hand-edited size to the largest option', () => {
    const largest = MAX_PAGE_SIZE;
    expect(parsePageSize('999999')).toBe(largest);
  });
});

describe('parsePage', () => {
  it('defaults to the first page for anything unusable', () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('x')).toBe(1);
    expect(parsePage('7')).toBe(7);
  });
});

describe('pageCount and clampPage', () => {
  it('counts partial pages and never drops below one', () => {
    expect(pageCount(23, 10)).toBe(3);
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(23, ALL)).toBe(1);
  });

  it('pulls a stale page back into range', () => {
    expect(clampPage(99, 23, 10)).toBe(3);
    expect(clampPage(2, 0, 10)).toBe(1);
    expect(clampPage(4, 23, ALL)).toBe(1);
  });
});

describe('pageSlice', () => {
  it('returns the requested window', () => {
    expect(pageSlice(rows, 1, 10)).toEqual(rows.slice(0, 10));
    expect(pageSlice(rows, 3, 10)).toEqual(rows.slice(20));
  });

  it('returns every row for "all"', () => {
    expect(pageSlice(rows, 1, ALL)).toEqual(rows);
  });

  it('falls back to the last page rather than an empty window', () => {
    expect(pageSlice(rows, 99, 10)).toEqual(rows.slice(20));
  });
});

describe('pageQuery', () => {
  it('converts a page into LIMIT/OFFSET', () => {
    expect(pageQuery(1, 10)).toEqual({ limit: 10, offset: 0 });
    expect(pageQuery(3, 10)).toEqual({ limit: 10, offset: 20 });
  });

  it('caps "all" instead of leaving the query unbounded', () => {
    expect(pageQuery(4, ALL)).toEqual({ limit: ALL_LIMIT, offset: 0 });
  });
});

describe('pageRange', () => {
  it('reports the 1-based row range', () => {
    expect(pageRange(1, 10, 23)).toEqual({ from: 1, to: 10 });
    expect(pageRange(3, 10, 23)).toEqual({ from: 21, to: 23 });
    expect(pageRange(1, ALL, 23)).toEqual({ from: 1, to: 23 });
  });

  it('reports an empty range for an empty list', () => {
    expect(pageRange(1, 10, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe('pageHref', () => {
  it('omits the defaults so the plain URL stays clean', () => {
    expect(pageHref('/admin/users', 1, DEFAULT_PAGE_SIZE)).toBe('/admin/users');
  });

  it('carries page and size when they differ from the defaults', () => {
    expect(pageHref('/admin/users', 2, 25)).toBe('/admin/users?page=2&size=25');
    expect(pageHref('/admin/users', 1, ALL)).toBe('/admin/users?size=all');
  });

  it('preserves unrelated filters and drops its own stale parameters', () => {
    expect(pageHref('/dashboard/usage', 2, 25, { tab: 'details', page: 9, empty: '' })).toBe(
      '/dashboard/usage?tab=details&page=2&size=25',
    );
  });

  it('keeps other parameters while still omitting the default size', () => {
    expect(pageHref('/dashboard/usage', 2, DEFAULT_PAGE_SIZE, { tab: 'details' })).toBe(
      '/dashboard/usage?tab=details&page=2',
    );
  });

  it('uses the overridden parameter names for a second list on the page', () => {
    expect(
      pageHref('/admin/sources', 2, 25, { page: '3' }, { page: 'upage', size: 'usize' }),
    ).toBe('/admin/sources?page=3&upage=2&usize=25');
  });
});
