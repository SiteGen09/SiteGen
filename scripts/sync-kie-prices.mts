/**
 * Reprice kie.ai channels from kie.ai's published catalogue once.
 * Dry run by default; --apply writes, exactly as the server's hourly sync does.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { syncKiePrices } from '../lib/ai/kie-price-sync';
import { logger } from '../lib/log';
config({ path: '.env.local', quiet: true });

const apiKey = process.env.KIE_API_KEY;
if (!apiKey) throw new Error('KIE_API_KEY is required');
const apply = process.argv.includes('--apply');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  const plan = await syncKiePrices({ sql, apiKey, log: logger({ component: 'kie_prices' }), dryRun: !apply });
  console.table(plan.updates.map(({ id, from, to }) => ({ id, from: from.join(' / '), to: to.join(' / ') })));
  if (plan.review.length) console.table(plan.review);
  if (plan.missing.length) console.log('Active channels kie.ai no longer lists:', plan.missing.join(', '));
  console.log(`${apply ? 'Repriced' : 'Would reprice'} ${plan.updates.length}; ${plan.unchanged} current; ${plan.review.length} held for review.`);
} finally {
  await sql.end();
}
