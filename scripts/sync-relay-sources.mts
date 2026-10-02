/**
 * Reprice Relay chat channels from the Relay account's selected sources once.
 * Dry run by default; --apply writes, exactly as the server's minute sync does.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { syncRelaySources } from '../lib/ai/relay-sources';
import { logger } from '../lib/log';
config({ path: '.env.local', quiet: true });

const token = process.env.RELAY_ACCESS_TOKEN;
const userId = process.env.RELAY_USER_ID;
if (!token || !userId) throw new Error('RELAY_ACCESS_TOKEN and RELAY_USER_ID are required');
const apply = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  const result = await syncRelaySources({ sql, token, userId, log: logger({ component: 'relay_sources' }), dryRun: !apply });
  console.table(Object.entries(result.sources).map(([family, s]) => ({ family, source: s.label, tier: s.tier, unitPrice: s.unitPrice })));
  console.table(result.repriced);
  console.log(`${apply ? 'Repriced' : 'Would reprice'} ${result.repriced.length} channel(s); ${result.unchanged} already current.`);
} finally {
  await sql.end();
}
