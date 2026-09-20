import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import { sql } from '@/lib/db';

let createSources: string;
let backfill: string;
let widen: string;
beforeAll(async () => {
  const bootstrap = await readFile(
    'supabase/migrations/20260920000100_routing_sources.sql',
    'utf8',
  );
  // Execute the shipped table definition and inference SQL, rather than a
  // second hand-maintained copy of its regex that could pass while DDL drifts.
  createSources = bootstrap
    .slice(
      bootstrap.indexOf('CREATE TABLE sources ('),
      bootstrap.indexOf('CREATE UNIQUE INDEX sources_default_family_key'),
    )
    .replace('CREATE TABLE sources', 'CREATE TEMP TABLE sources')
    .replace(');', ') ON COMMIT DROP;');
  backfill = bootstrap.slice(
    bootstrap.indexOf('DO $$'),
    bootstrap.indexOf('UPDATE channels SET source_id'),
  );
  widen = await readFile('supabase/migrations/20260920000600_widen_source_families.sql', 'utf8');
});
afterAll(async () => {
  await sql.end();
});

async function prepareBootstrap(tx: TransactionSql): Promise<void> {
  // Temporary relations shadow only this connection's public tables. Every
  // test commits or rolls back its own DDL without altering the local catalog.
  await tx.unsafe(createSources);
  await tx`CREATE TEMP TABLE channels (
    id text, public_model_id text, model_id text, provider text,
    is_byok boolean DEFAULT false, label text DEFAULT 'Test',
    credit_multiplier numeric(10,2) DEFAULT 1.23, min_plan text DEFAULT 'free'
  ) ON COMMIT DROP`;
}

describe('routing migrations', () => {
  it('backfills all supported model families by name with exact prices, regardless of wire protocol', async () => {
    await sql.begin(async (tx) => {
      await prepareBootstrap(tx);
      const models = [
        ['claude-sonnet-4', 'claude'],
        ['gpt-5', 'gpt'],
        ['grok-3', 'grok'],
        ['DeepSeek-R1', 'deepseek'],
        ['Qwen2.5-72B', 'qwen'],
        ['o4-mini', 'gpt'],
        ['stub-fixture', 'gpt'],
      ] as const;
      for (const [model] of models) {
        await tx`INSERT INTO channels (id,model_id,provider) VALUES (${model},${model},'openai_compatible')`;
      }
      await tx.unsafe(backfill);
      const sources = await tx<
        { id: string; family: string; credit_multiplier: string }[]
      >`SELECT id,family,credit_multiplier FROM sources`;
      for (const [model, family] of models) {
        expect(sources.find((source) => source.id === 'legacy-' + model)).toMatchObject({
          family,
          credit_multiplier: '1.23',
        });
      }
    });
  });

  it('still rejects an unknown model even when its protocol looks like a known vendor', async () => {
    await expect(
      sql.begin(async (tx) => {
        await prepareBootstrap(tx);
        await tx`INSERT INTO channels (id,model_id,provider) VALUES ('unknown','unmapped-vendor-model','anthropic')`;
        await tx.unsafe(backfill);
      }),
    ).rejects.toMatchObject({
      message:
        'Unmapped channel family: add an explicit model-name mapping to routing_sources before applying',
    });
  });

  it('fails before index creation with the conflicting source, model and channels named', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE sources (id text, family text CONSTRAINT sources_family_check CHECK (family IN ('gpt','claude','grok'))) ON COMMIT DROP`;
        await tx`CREATE TEMP TABLE user_routing_preferences (family text CONSTRAINT user_routing_preferences_family_check CHECK (family IN ('gpt','claude','grok'))) ON COMMIT DROP`;
        await tx`CREATE TEMP TABLE channels (id text, source_id text, public_model_id text, status text) ON COMMIT DROP`;
        // An off channel still owns its name; toggling it back on must be safe.
        await tx`INSERT INTO channels VALUES ('a','duplicate-source','shared-model','active'),('b','duplicate-source','shared-model','off')`;
        await tx.unsafe(widen);
      }),
    ).rejects.toMatchObject({
      message:
        'Cannot create channels_source_public_model_key: source "duplicate-source" has duplicate public model "shared-model" on channels: a, b',
      hint: 'Reassign or remove duplicate channel routes, then rerun this migration. Disabled channels also count.',
    });
  });
});
