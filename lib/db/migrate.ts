import postgres from 'postgres';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

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

  for (const file of sqlFiles) {
    console.log(`Applying ${file}...`);
    const content = await readFile(join(migrationsDir, file), 'utf-8');
    await sql.unsafe(content);
  }

  await sql.end();
  console.log('Migrations complete');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
