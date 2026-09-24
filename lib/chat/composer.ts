import { z } from 'zod';

export type ChatMode = 'chat' | 'image' | 'video';
export type ComposerMode = 'auto' | ChatMode;
// Stable default, followed by the lowest-priced active Kie Flash models.
// Keep the server fallback chain in 20260921000500_kie_chat_fallback.sql aligned.
export const DEFAULT_CHAT_MODELS = [
  'gemini-3-5-flash-openai',
  'gemini-3-6-flash-openai',
  'gemini-3-7-flash-openai',
  'gemini-3-8-flash-openai',
] as const;
export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_ACCEPT = '.txt,.md,.csv,.json,.log,.ts,.tsx,.js,.py,.html,.css,image/png,image/jpeg,image/webp,image/gif';

export const attachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), name: z.string().min(1).max(255), text: z.string().max(32000) }),
  z.object({
    kind: z.literal('image'), name: z.string().min(1).max(255),
    data: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 100)
      .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, 'Use a PNG, JPEG, WebP, or GIF image.'),
  }),
]);
export type ChatAttachment = z.infer<typeof attachmentSchema>;
export const attachmentsSchema = z.array(attachmentSchema).max(MAX_ATTACHMENTS).superRefine((files, ctx) => {
  const bytes = files.reduce((sum, file) => sum + (file.kind === 'image'
    ? Math.ceil((file.data.split(',')[1]?.length ?? 0) * 3 / 4)
    : new TextEncoder().encode(file.text).length), 0);
  if (bytes > MAX_ATTACHMENT_BYTES) ctx.addIssue({ code: 'custom', message: 'Attachments must total 2 MB or less.' });
});

// Require creation intent so discussing media does not start a paid render.
export function detectMode(prompt: string): ChatMode {
  const text = prompt.trim().toLowerCase();
  if (/\b(?:don['’]?t|do not|never)\b/.test(text) ||
      /\b(?:how (?:do|can|to)|explain|analy[sz]e|summari[sz]e|describe|write|script|code|prompt for|storyboard|ideas? for)\b/.test(text)) return 'chat';
  const request = /^(?:(?:please|can you|could you|would you|i want (?:you to|to)|i need you to)\s+)*(?:create|generate|make|render|draw|paint|design|animate)\b/.exec(text);
  if (!request) return 'chat';
  const subject = text.slice(request[0].length).split(/[.!?;\n]/)[0] ?? '';
  if (/\b(?:video|clip|animation|movie)\b/.test(subject) || /animate$/.test(request[0])) return 'video';
  if (/\b(?:image|picture|photo|illustration|artwork|portrait|logo|poster|wallpaper|icon)\b/.test(subject) || /(?:draw|paint)$/.test(request[0])) return 'image';
  return 'chat';
}

// The catalogue has no input-capability metadata. Use known multimodal model
// families conservatively; a configured provider may further limit support.
export function supportsImages(model: string): boolean {
  return /(?:gpt-(?:4o|4\.1|5|6)|claude-(?:3|4|sonnet|opus|haiku)|gemini|\bvision\b)/i.test(model);
}

export function supportsTextGeneration(model: string): boolean {
  return !/(?:image-to-(?:image|video)|video-to-video|(?:^|[-/])(?:edit|remix|upscale|remove-background|segment|character|layer-decomposition|extend|motion-control)(?:$|[-/]))/i.test(model);
}

export function chooseModel(models: string[], kind: ChatMode, needsImages = false): string {
  const eligible = kind !== 'chat' ? models.filter(supportsTextGeneration) : needsImages ? models.filter(supportsImages) : models;
  if (kind === 'chat') {
    const defaultModel = DEFAULT_CHAT_MODELS.find((name) => eligible.includes(name));
    if (defaultModel) return defaultModel;
  }
  if (kind !== 'chat') {
    const textModel = eligible.find((name) => name.includes('text-to-' + kind));
    if (textModel) return textModel;
  }
  const preferred = kind === 'chat' ? /(?:flash|mini|haiku|sonnet)/i
    : kind === 'image' ? /(?:text-to-image|gpt-image|flux|imagen)/i : /(?:text-to-video|sora|veo)/i;
  return eligible.find((name) => preferred.test(name)) ?? eligible[0] ?? '';
}

const SAVED_PREFIX = '[[chat-attachments:v1]]';
const turnSchema = z.object({ text: z.string(), attachments: attachmentsSchema });
export function encodeTurn(text: string, attachments: ChatAttachment[]): string {
  return attachments.length || text.startsWith(SAVED_PREFIX) ? SAVED_PREFIX + JSON.stringify({ text, attachments }) : text;
}
export function decodeTurn(content: string): { text: string; attachments: ChatAttachment[] } {
  if (content.startsWith(SAVED_PREFIX)) {
    try { return turnSchema.parse(JSON.parse(content.slice(SAVED_PREFIX.length))); } catch { /* legacy text */ }
  }
  return { text: content, attachments: [] };
}

export function turnText(text: string, attachments: ChatAttachment[]): string {
  return [text, ...attachments.flatMap((file) => file.kind === 'text'
    ? ['Attached file: ' + file.name + '\n' + file.text] : [])].filter(Boolean).join('\n\n');
}

export async function readAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(file.name + ': attachments must total 2 MB or less.');
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read ' + file.name));
      reader.readAsDataURL(file);
    });
    return attachmentSchema.parse({ kind: 'image', name: file.name, data });
  }
  if (!/\.(txt|md|csv|json|log|ts|tsx|js|py|html|css)$/i.test(file.name)) {
    throw new Error(file.name + ': use an image or a text file. Video, PDF, and Office attachments are not supported yet.');
  }
  const text = await file.text();
  if (text.includes('\0') || text.length > 32000) throw new Error(file.name + ': use a text file with at most 32,000 characters.');
  return attachmentSchema.parse({ kind: 'text', name: file.name, text });
}
