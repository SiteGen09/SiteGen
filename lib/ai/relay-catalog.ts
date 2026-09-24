import { z } from 'zod';
import { billingPolicySchema, type BillingPolicy } from './billing-policy';

export const RELAY_BASE_URL = 'https://relay.fast/v1';
const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const modelSchema = z.object({
  model_name: z.string().min(1).max(128),
  quota_type: z.union([z.literal(0), z.literal(1)]),
  model_ratio: nonnegative, completion_ratio: nonnegative, model_price: nonnegative,
  cache_ratio: nonnegative.optional(), create_cache_ratio: nonnegative.optional(),
  billing_multiplier: positive.nullish(), billing_mode: z.string().optional(), billing_expr: z.string().optional(),
  group_ratio: z.object({ default: positive }), enable_groups: z.array(z.string()),
  context_length: z.number().int().positive().optional(), vendor_id: z.number(),
  supported_endpoint_types: z.array(z.string()),
  image_pricing_tiers: z.array(z.object({ label: z.string(), price: nonnegative, unit: z.literal('image') })).optional(),
});
export const relayCatalogSchema = z.object({
  success: z.literal(true), pricing_version: z.string(), data: z.array(modelSchema).min(1),
  vendors: z.array(z.object({ id: z.number(), name: z.string() })),
});
const families: Record<string, string> = { OpenAI: 'gpt', Anthropic: 'claude', Google: 'gemini', xAI: 'grok', DeepSeek: 'deepseek', MiniMax: 'minimax', '智谱': 'zhipu', Tencent: 'tencent', Moonshot: 'moonshot', Xiaomi: 'xiaomi' };

/** Parse the published arithmetic grammar. Never execute remote expressions. */
export function parseRelayExpression(raw: string, factor: number): Pick<BillingPolicy, 'tiers' | 'contextThreshold' | 'peakUtcHours'> {
  const expr = raw.replace(/\\"/g, '"');
  const matches = [...expr.matchAll(/tier\("([a-z_]+)",\s*([^()]+)\)/g)];
  if (!matches.length) throw new Error('Unrecognized Relay billing expression');
  const tiers = matches.map(m => {
    const terms = new Map<string, number>();
    for (const part of m[2]!.split('+')) {
      const term = /^\s*(p|c|cr|cc)\s*\*\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
      if (!term || terms.has(term[1]!)) throw new Error('Unrecognized Relay rate term');
      terms.set(term[1]!, Number(term[2]) * factor);
    }
    if (!terms.has('p') || !terms.has('c')) throw new Error('Missing Relay input/output rate');
    return { name: m[1]!, rates: { inputPerMTok: terms.get('p')!, outputPerMTok: terms.get('c')!, cachedPerMTok: terms.get('cr') ?? terms.get('p')!, ...(terms.has('cc') ? { cacheWritePerMTok: terms.get('cc')! } : {}) } };
  });
  const skeleton = expr.replace(/tier\("([a-z_]+)",\s*([^()]+)\)/g, 'T').replace(/\s+/g, '');
  const context = /^len<=(\d+)\?T:T$/.exec(skeleton);
  if (context && tiers.length === 2) return { tiers, contextThreshold: Number(context[1]) };
  if (skeleton === 'T' && tiers.length === 1) return { tiers };
  if (skeleton === '((hour("UTC")>=1&&hour("UTC")<4)||(hour("UTC")>=6&&hour("UTC")<10))?T:T' && tiers.map(t => t.name).join(',') === 'peak,off_peak') {
    return { tiers, peakUtcHours: [[1, 4], [6, 10]] };
  }
  throw new Error('Unsupported Relay billing condition');
}

export function relayChannels(raw: unknown, now = new Date()) {
  const catalog = relayCatalogSchema.parse(raw);
  const names = new Set<string>();
  return catalog.data.map(model => {
    if (names.has(model.model_name)) throw new Error('Duplicate Relay model');
    names.add(model.model_name);
    if (!model.enable_groups.includes('default')) throw new Error('Model unavailable to default group');
    const vendor = catalog.vendors.find(v => v.id === model.vendor_id)?.name;
    const family = vendor && families[vendor];
    if (!family) throw new Error(`Unknown Relay vendor for ${model.model_name}`);
    const image = model.quota_type === 1;
    if (!model.supported_endpoint_types.includes(image ? 'image-generation' : 'openai')) throw new Error('Unsupported Relay protocol');
    const factor = model.group_ratio.default * (model.billing_multiplier ?? 1);
    const base = model.model_ratio * 2;
    let pricing: Pick<BillingPolicy, 'tiers' | 'contextThreshold' | 'peakUtcHours'> = { tiers: [{ name: 'standard', rates: { inputPerMTok: base * factor, outputPerMTok: base * model.completion_ratio * factor, cachedPerMTok: base * (model.cache_ratio ?? 1) * factor, ...(model.create_cache_ratio === undefined ? {} : { cacheWritePerMTok: base * model.create_cache_ratio * factor }) } }] };
    if (model.billing_mode === 'tiered_expr') {
      if (!model.billing_expr) throw new Error('Missing Relay billing expression');
      pricing = parseRelayExpression(model.billing_expr, factor);
    } else if (model.billing_mode && model.billing_mode !== 'ratio') throw new Error('Unknown Relay billing mode');
    let imagePrices: BillingPolicy['imagePrices'];
    if (image) {
      const tiers = model.image_pricing_tiers;
      if (tiers && (tiers.length !== 2 || tiers[0]!.label !== '1K / <=1792 px' || tiers[1]!.label !== '2K / 4K / >1792 px')) throw new Error('Unknown image pricing tiers');
      imagePrices = { standard: (tiers?.[0]?.price ?? model.model_price) * factor, large: (tiers?.[1]?.price ?? model.model_price) * factor };
    }
    const policy = billingPolicySchema.parse({ origin: 'relay.fast', version: catalog.pricing_version, syncedAt: now.toISOString(), ...pricing, ...(imagePrices ? { imagePrices } : {}) });
    const rates = policy.tiers[0]!.rates;
    return {
      id: `relay-${model.model_name}`, label: model.model_name, task: image ? 'image.generate' : 'chat.completions',
      provider: image ? 'openai_images' : 'openai_compatible', base_url: RELAY_BASE_URL,
      model_id: model.model_name, public_model_id: model.model_name, source_id: `relay-${family}-${image ? 'image' : 'chat'}`,
      family, modality: image ? 'image' : 'chat', vendor: vendor!.toLowerCase() === '智谱' ? 'zhipu' : vendor!.toLowerCase(),
      context_window: model.context_length ?? null, endpoints: model.supported_endpoint_types,
      tags: ['relay.fast', ...(policy.contextThreshold ? ['tiered'] : []), ...(policy.peakUtcHours ? ['time-based'] : [])],
      pricing_type: image ? 'request' : 'token', request_price_usd: imagePrices?.standard ?? null,
      input_per_mtok: imagePrices?.standard ?? rates.inputPerMTok, output_per_mtok: image ? 0 : rates.outputPerMTok, cached_per_mtok: image ? 0 : rates.cachedPerMTok,
      list_input_per_mtok: image ? model.model_price : base, list_output_per_mtok: image ? null : base * model.completion_ratio,
      list_cached_per_mtok: image ? null : base * (model.cache_ratio ?? 1), billing_policy: policy,
    };
  });
}
