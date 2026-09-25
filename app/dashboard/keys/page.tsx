import { listMediaModelOptions, listPublicModelOptions } from '@/lib/ai/channels';
import { USD_PER_CREDIT } from '@/lib/ai/pricing';
import { publicRoutingSourceId } from '@/lib/ai/routing-provider';
import { loadRoutingPreferences } from '@/lib/ai/sources';
import { loadKeyRoutingChoices } from '@/lib/dashboard/key-routing-choices';
import { getEntitlement, listApiKeys } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { PageHeader } from '../ui';
import { KeysManager, type KeyView, type ModelGroup } from './keys-manager';

export const metadata = { title: 'API keys — sitegen' };

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export default async function KeysPage() {
  const user = await requireUser();
  const [keys, entitlement, preferences] = await Promise.all([
    listApiKeys(),
    getEntitlement(user.id),
    loadRoutingPreferences(user.id),
  ]);
  const [chat, image, video, routing] = await Promise.all([
    listPublicModelOptions(entitlement.planKey, preferences),
    listMediaModelOptions(entitlement.planKey, 'image', preferences),
    listMediaModelOptions(entitlement.planKey, 'video', preferences),
    loadKeyRoutingChoices(entitlement.planKey),
  ]);

  const modelGroups: ModelGroup[] = [
    { label: 'Chat', models: chat.map((option) => option.id) },
    { label: 'Image', models: image.map((option) => option.id) },
    { label: 'Video', models: video.map((option) => option.id) },
  ].filter((group) => group.models.length > 0);

  // Internal routing ids never reach the browser: providers and sources are
  // shown and posted by their public aliases.
  const views: KeyView[] = keys.map((key) => ({
    id: key.id,
    name: key.name,
    masked: `${key.key_prefix}…${key.last_four}`,
    status: key.status,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at,
    expiresAt: key.expires_at,
    rateLimitRpm: key.rate_limit_rpm,
    quotaUsd: key.quota_credits === null ? null : key.quota_credits * USD_PER_CREDIT,
    usedUsd: key.used_credits * USD_PER_CREDIT,
    allowedModels: key.allowed_models,
    allowedIps: key.allowed_ips,
    routingProvider: key.routing_provider_id === null
      ? ''
      : routing.providers.find((provider) => provider.id === key.routing_provider_id)?.publicId ?? 'unavailable',
    routingSources: Object.fromEntries(
      Object.entries(key.routing_sources).map(([pair, sourceId]) => [pair, publicRoutingSourceId(sourceId)]),
    ),
  }));

  return (
    <>
      <PageHeader
        title="API keys"
        description="Authenticate requests with Authorization: Bearer <key>. Keys are shown once at creation; everything else can be changed later."
      />
      <KeysManager
        keys={views}
        endpoints={[
          { label: 'OpenAI-compatible', url: `${APP_URL}/v1` },
          { label: 'Anthropic-compatible', url: APP_URL },
        ]}
        modelGroups={modelGroups}
        routing={{
          providers: routing.providers.map(({ publicId, label }) => ({ publicId, label })),
          pairs: routing.pairs,
        }}
      />
    </>
  );
}
