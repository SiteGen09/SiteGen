import { z } from 'zod';

// Safe to share with the browser: only public model names and message text.
export const conversationSchema = z.object({
  id: z.uuid(), title: z.string(), model: z.string(), updated_at: z.string(),
});
export const savedMessageSchema = z.object({
  id: z.uuid(), role: z.enum(['user', 'assistant', 'system']), content: z.string(),
  model: z.string(), tokens: z.coerce.number().nullable(), created_at: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type SavedMessage = z.infer<typeof savedMessageSchema>;
