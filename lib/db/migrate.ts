import postgres from 'postgres';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';

// Unlike Next, this CLI must load env files itself. Explicit shell values win.
config({ path: '.env.local', quiet: true });

async function migrate() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL not set');
  }

  const sql = postgres(connectionString, { max: 1 });

  console.log('Running migrations...');

  const migrationsDir = join(process.cwd(), 'supabase/migrations');
  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();

  try {
    // Share Supabase CLI history so an existing database never replays DDL.
    await sql`CREATE SCHEMA IF NOT EXISTS supabase_migrations`;
    await sql`CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
      version text PRIMARY KEY, statements text[], name text
    )`;
    for (const file of sqlFiles) {
      const version = file.split('_')[0]!;
      const content = await readFile(join(migrationsDir, file), 'utf-8');
      await sql.begin(async (tx) => {
        // Concurrent deployments must not both decide a migration is new.
        await tx`SELECT pg_advisory_xact_lock(20260920)`;
        const applied = await tx`SELECT version FROM supabase_migrations.schema_migrations WHERE version = ${version}`;
        if (applied.length > 0) return;
        console.log(`Applying ${file}...`);
        await tx.unsafe(content);
        await tx`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (${version}, ${file})`;
      });
    }
  } finally {
    await sql.end();
  }
  console.log('Migrations complete');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
