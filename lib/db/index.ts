import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// A pool of 1 suits serverless (one connection per isolated process). On a
// long-lived server every query would serialise through it, so make it tunable.
const poolMax = Number(process.env.DB_POOL_MAX ?? 10);

export const sql = postgres(connectionString, { max: poolMax });
export const db = drizzle(sql, { schema });
