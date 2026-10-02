import { randomUUID } from 'node:crypto';

import { ApiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { formFiles, formText, readSupportForm, supportError } from '@/lib/support/http';
import { checkAttachments } from '@/lib/support/attachments';
import { addCustomerMessage, replySchema } from '@/lib/support/tickets';

export const runtime = 'nodejs';

/** A customer's follow-up on their own request. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'support.ticket_reply' });
  try {
    const { id } = await context.params;
    const { user, form } = await readSupportForm(request);
    const parsed = replySchema.safeParse({ body: formText(form, 'body') });
    if (!parsed.success) throw new ApiError('invalid_request', 'Enter a message of up to 10,000 characters.', 400);
    const attachments = await checkAttachments(formFiles(form, 'files'));
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError('not_found', 'That request no longer exists.', 404);
    await addCustomerMessage(user.id, id, parsed.data.body, attachments);
    return Response.json({ ok: true }, { status: 201 });
  } catch (error) {
    return supportError(error, requestId, log);
  }
}
