import { listSources } from '@/lib/ai/sources';
import { Fragment } from 'react';
import { z } from 'zod';

import { requireAdmin } from '@/lib/api/admin';
import { PLAN_KEYS } from '@/lib/billing/plans';
import { createServiceClient } from '@/lib/supabase/service';
import { clampPage, pageSlice, parsePage, parsePageSize } from '@/lib/ui/pagination';

import { Badge, Card, EmptyRow, PageTitle, Pager, Td, Th } from '../_components/ui';
import { BUTTON_SUBTLE_CLASS } from '../_components/action-state';
import {
  CreateChannelForm,
  EditChannelForm,
  type ChannelDefaults,
} from './_components/channel-forms';
import { ChannelTestButton } from './_components/test-button';
import { toggleChannelAction } from './actions';

export const dynamic = 'force-dynamic';

const channelRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  task: z.string(),
  provider: z.string(),
  base_url: z.string().nullable(),
  model_id: z.string(),
  is_byok: z.boolean(),
  source_id: z.string().nullable(),
  vendor: z.string().nullable(),
  context_window: z.coerce.number().nullable(),
  endpoints: z.array(z.string()),
  tags: z.array(z.string()),
  pricing_type: z.enum(['token', 'request']),
  list_input_per_mtok: z.coerce.number().nullable(),
  list_output_per_mtok: z.coerce.number().nullable(),
  list_cached_per_mtok: z.coerce.number().nullable(),
  public_model_id: z.string().nullable(),
  input_per_mtok: z.union([z.string(), z.number()]).transform(String),
  output_per_mtok: z.union([z.string(), z.number()]).transform(String),
  cached_per_mtok: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  min_plan: z.string(),
  fallback_to: z.string().nullable(),
  priority: z.union([z.string(), z.number()]).transform(Number),
  updated_at: z.union([z.string(), z.date()]),
});

const COLS = 11;

function toDefaults(row: z.infer<typeof channelRowSchema>): ChannelDefaults {
  return {
    vendor: row.vendor ?? '',
    contextWindow: row.context_window === null ? '' : String(row.context_window),
    endpoints: row.endpoints.join(', '),
    tags: row.tags.join(', '),
    pricingType: row.pricing_type,
    listInputPerMTok: row.list_input_per_mtok === null ? '' : String(row.list_input_per_mtok),
    listOutputPerMTok: row.list_output_per_mtok === null ? '' : String(row.list_output_per_mtok),
    listCachedPerMTok: row.list_cached_per_mtok === null ? '' : String(row.list_cached_per_mtok),
    id: row.id,
    label: row.label,
    task: row.task,
    provider: row.provider,
    baseUrl: row.base_url ?? '',
    modelId: row.model_id,
    sourceId: row.source_id ?? '',
    isByok: row.is_byok,
    publicModelId: row.public_model_id ?? '',
    inputPerMTok: row.input_per_mtok,
    outputPerMTok: row.output_per_mtok,
    cachedPerMTok: row.cached_per_mtok,
    status: row.status,
    minPlan: row.min_plan,
    fallbackTo: row.fallback_to ?? '',
    priority: String(row.priority),
  };
}

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; size?: string }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const size = parsePageSize(sp.size);
  const sources = await listSources();
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select('*')
    .order('task', { ascending: true })
    .order('priority', { ascending: false });

  if (error !== null) {
    throw new Error(`failed to load channels: ${error.message}`);
  }

  const all = z.array(channelRowSchema).parse(data ?? []);
  // Fallback targets are chosen across the whole catalogue, not just the page
  // being viewed, so the select stays complete however the table is sliced.
  const channelIds = all.map((r) => r.id);
  const page = clampPage(parsePage(sp.page), all.length, size);
  const rows = pageSlice(all, page, size);

  return (
    <>
      <PageTitle
        title="Channels"
        subtitle="Serving channels. Source changes apply on the next request."
      />

      <div className="mb-6">
        <Card>
          <details>
            <summary className="cursor-pointer text-sm font-medium text-zinc-200">
              New channel
            </summary>
            <div className="mt-4">
              <CreateChannelForm
                planKeys={PLAN_KEYS}
                sourceOptions={sources}
                fallbackOptions={channelIds}
              />
            </div>
          </details>
        </Card>
      </div>

      <Card title="All channels">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[72rem] text-sm">
            <thead>
              <tr>
                <Th>Label</Th>
                <Th>Task</Th>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th>Source</Th>
                <Th>Status</Th>
                <Th>Min plan</Th>
                <Th>Fallback</Th>
                <Th>Prio</Th>
                <Th>Updated</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.length === 0 ? (
                <EmptyRow colSpan={COLS} label="No channels yet." />
              ) : (
                rows.map((row) => (
                  <Fragment key={row.id}>
                    <tr>
                      <Td>
                        <div className="font-medium text-zinc-100">{row.label}</div>
                        <div className="font-mono text-xs text-zinc-500">{row.id}</div>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{row.task}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{row.provider}</span>
                      </Td>
                      <Td>
                        <span className="font-mono text-xs">{row.model_id}</span>
                      </Td>
                      <Td>
                        {sources.find((source) => source.id === row.source_id)?.label ?? 'BYOK'}
                      </Td>
                      <Td>
                        <Badge value={row.status} />
                      </Td>
                      <Td>{row.min_plan}</Td>
                      <Td>
                        <span className="font-mono text-xs">{row.fallback_to ?? '—'}</span>
                      </Td>
                      <Td>{row.priority}</Td>
                      <Td>
                        <span className="text-xs text-zinc-500">
                          {new Date(row.updated_at).toLocaleString()}
                        </span>
                      </Td>
                      <Td>
                        <div className="flex flex-col gap-2">
                          <ChannelTestButton channelId={row.id} />
                          <form action={toggleChannelAction}>
                            <input type="hidden" name="id" value={row.id} />
                            <button type="submit" className={BUTTON_SUBTLE_CLASS}>
                              {row.status === 'active' ? 'Disable' : 'Enable'}
                            </button>
                          </form>
                        </div>
                      </Td>
                    </tr>
                    <tr>
                      <td colSpan={COLS} className="px-3 pb-4">
                        <details>
                          <summary className="cursor-pointer text-xs font-medium text-zinc-400">
                            Edit {row.id}
                          </summary>
                          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/50 p-4">
                            <EditChannelForm
                              defaults={toDefaults(row)}
                              planKeys={PLAN_KEYS}
                              sourceOptions={sources}
                              fallbackOptions={channelIds.filter((id) => id !== row.id)}
                            />
                          </div>
                        </details>
                      </td>
                    </tr>
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath="/admin/channels"
          page={page}
          pageSize={size}
          total={all.length}
          label="channels"
        />
      </Card>
    </>
  );
}
