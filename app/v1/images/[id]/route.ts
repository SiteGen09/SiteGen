import { handleRead } from '@/lib/media/handlers';

/** See `lib/media/handlers.ts`: both media endpoints share one implementation. */
export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleRead(request, id, 'image');
}
