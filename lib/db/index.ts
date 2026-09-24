import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL!;

// A pool of 1 suits serverless (one connection per isolated process). On a
// long-lived server every query would serialise through it, so make it tunable.
const poolMax = Number(process.env.DB_POOL_MAX ?? 10);

// Raw queries rely on postgres.js's default parsers (timestamptz -> Date).
// Never pass this client to drizzle(): drizzle-orm's postgres-js driver
// replaces the client's timestamp parsers and serializers with pass-throughs,
// so every `sql` query would return timestamps as strings. lib/db/schema.ts
// remains the drizzle-kit schema source only.
export const sql = postgres(connectionString, { max: poolMax });
