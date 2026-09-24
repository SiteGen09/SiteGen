/**
 * Routing families: model identity, never the wire protocol. A Gemini model
 * served through an OpenAI-compatible relay still belongs to `gemini`. Kept in
 * step with the CHECK constraints in 20260921000300_routing_modality.sql.
 */
export const FAMILIES = [
  'gpt',
  'claude',
  'grok',
  'deepseek',
  'qwen',
  'gemini',
  'zhipu',
  'moonshot',
  'minimax',
  'tencent',
  'xiaomi',
  // Media vendors. They arrived with the image and video catalogue and are
  // families in exactly the same sense: a Kling model is a Kling model
  // wherever it is served from.
  'bytedance',
  'kling',
  'wan',
  'runway',
  'pixverse',
  'ideogram',
  'flux',
  'topaz',
  'elevenlabs',
  'suno',
  'alibaba',
  // Deliberate catch-all. The upstream catalogue labels some models "Other",
  // and inventing a family for each would be worse than admitting we do not
  // know: routing still works, it just groups them together.
  'other',
] as const;
export type Family = (typeof FAMILIES)[number];

/**
 * What a source produces.
 *
 * Family alone cannot key a routing preference. One vendor serves chat, images
 * and video, and those are separate decisions: picking a gateway for GPT chat
 * says nothing about who should render your images, and a single preference
 * row would let one choice silently repoint the others. So a preference is
 * keyed on family AND modality, and a source declares which one it serves.
 */
export const MODALITIES = ['chat', 'image', 'video'] as const;
export type Modality = (typeof MODALITIES)[number];

export const MODALITY_LABELS: Record<Modality, string> = {
  chat: 'Chat',
  image: 'Image',
  video: 'Video',
};

/**
 * A preference key. Composite because the pair is what identifies the
 * decision; a bare family would collide across modalities.
 */
export function routingKey(family: Family, modality: Modality): string {
  return `${family}:${modality}`;
}

/** Keyed by {@link routingKey}, valued by source id. */
export type RoutingPreferences = ReadonlyMap<string, string>;

/** The task a channel of this modality carries. */
export function taskForModality(modality: Modality): string {
  return modality === 'chat' ? 'chat.completions' : `${modality}.generate`;
}
