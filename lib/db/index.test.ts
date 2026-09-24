import { describe, expect, it } from 'vitest';
import { sql } from './index';

// Regression: drizzle(sql) once replaced these parsers with pass-throughs, so
// billing history rows carried string created_at values and
// `created_at.toISOString()` crashed /dashboard/billing/history and /admin/orders.
describe('shared sql client', () => {
  it.each([
    ['timestamptz', 1184, '2026-09-24 17:38:47.99+00'],
    ['timestamp', 1114, '2026-09-24 17:38:47.99'],
  ])('parses %s columns into Date objects', (_name, oid, raw) => {
    expect(sql.options.parsers[oid]!(raw)).toBeInstanceOf(Date);
  });
});
