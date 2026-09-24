/** A routing provider is the upstream company, not the API protocol it speaks. */
export interface RoutingProviderIdentity {
  id: string;
  label: string;
}

/**
 * Generic public identities keep the upstream companies behind this gateway
 * from becoming consumer-facing destinations.
 */
const ANONYMOUS_PROVIDER_ALIASES: Record<string, RoutingProviderIdentity> = {
  'relay.fast': { id: 'provider-a', label: 'Provider A' },
  'kie.ai': { id: 'provider-b', label: 'Provider B' },
};

export function routingProviderIdentity(input: {
  baseUrl?: string | null;
  provider?: string;
  sourceId?: string | null;
  sourceLabel?: string;
}): RoutingProviderIdentity {
  let host = '';
  try {
    host = new URL(input.baseUrl ?? '').hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Older source snapshots do not contain an endpoint.
  }
  for (const domain of ['relay.fast', 'kie.ai']) {
    if (host === domain || host.endsWith('.' + domain)) return { id: domain, label: domain };
  }
  // A hostname is safe display metadata; never return a URL with a path, query or credentials.
  if (host) return { id: host, label: host };
  const label = input.sourceLabel?.trim() ?? '';
  if (/^relay\.fast(?:$|\s)/i.test(label) || input.sourceId?.startsWith('relay-')) {
    return { id: 'relay.fast', label: 'relay.fast' };
  }
  if (/^kie\.ai(?:$|\s)/i.test(label) || input.sourceId?.startsWith('kie-')) {
    return { id: 'kie.ai', label: 'kie.ai' };
  }
  if (input.provider === 'anthropic') return { id: 'anthropic', label: 'Anthropic' };
  if (input.provider === 'openai' || input.provider === 'openai_responses') {
    return { id: 'openai', label: 'OpenAI' };
  }
  return { id: label.toLowerCase() || input.sourceId || 'unconfigured', label: label || 'Provider' };
}

/** Return the stable, anonymous identity safe to send to a consumer. */
export function publicRoutingProviderIdentity(input: {
  baseUrl?: string | null;
  provider?: string;
  sourceId?: string | null;
  sourceLabel?: string;
}): RoutingProviderIdentity {
  const identity = routingProviderIdentity(input);
  return publicRoutingProviderIdentityFromIdentity(identity);
}

/** Apply the public alias to an already-resolved internal identity. */
export function publicRoutingProviderIdentityFromIdentity(identity: RoutingProviderIdentity): RoutingProviderIdentity {
  return ANONYMOUS_PROVIDER_ALIASES[identity.id] ?? identity;
}

/** Whether an internal identity is one of the upstreams hidden from consumers. */
export function isAnonymousRoutingProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ANONYMOUS_PROVIDER_ALIASES, id);
}

/** Sanitize historical source snapshots before they reach the consumer dashboard. */
export function publicRoutingSourceLabel(label: string | null): string | null {
  if (label === null) return null;
  const internal = routingProviderIdentity({ sourceLabel: label });
  return isAnonymousRoutingProvider(internal.id)
    ? ANONYMOUS_PROVIDER_ALIASES[internal.id]!.label
    : label;
}

/** Replace known upstream names in free-form descriptions before rendering. */
export function publicRoutingText(text: string): string {
  return text
    .replace(/relay\.fast/gi, 'Provider A')
    .replace(/kie\.ai/gi, 'Provider B')
    .replace(/api\.provider-a\.com/gi, 'provider endpoint')
    .replace(/api\.provider-b\.com/gi, 'provider endpoint');
}

/** Remove upstream host tags from the public prices projection. */
export function publicRoutingTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => !/(?:relay\.fast|kie\.ai)/i.test(tag));
}

/** Stable opaque source IDs for the public routing picker. */
export function publicRoutingSourceId(sourceId: string): string {
  if (/^relay(?:-|\.fast$)/i.test(sourceId)) return 'source-a-' + opaqueSourceSuffix(sourceId);
  if (/^kie(?:-|\.ai$)/i.test(sourceId)) return 'source-b-' + opaqueSourceSuffix(sourceId);
  return sourceId;
}

/** A small deterministic hash keeps source aliases stable without encoding the source name. */
function opaqueSourceSuffix(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}
