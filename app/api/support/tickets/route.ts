import { randomUUID } from 'node:crypto';

import { ApiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { formFiles, formText, readSupportForm, supportError } from '@/lib/support/http';
import { checkAttachments } from '@/lib/support/attachments';
import { createTicket, newTicketSchema } from '@/lib/support/tickets';

export const runtime = 'nodejs';

function parseClientDiagnostics(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Opens a support request from the Contact support dialog. */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'support.ticket_create' });
  try {
    const { user, form } = await readSupportForm(request);
    const attachDiagnostics = formText(form, 'diagnostics') === 'on';
    const parsed = newTicketSchema.safeParse({
      subject: formText(form, 'subject'),
      category: formText(form, 'category'),
      priority: formText(form, 'priority') || 'normal',
      body: formText(form, 'body'),
      requestId: formText(form, 'requestId'),
      orderId: formText(form, 'orderId'),
      chatSessionId: formText(form, 'chatSessionId') || null,
      clientDiagnostics: attachDiagnostics ? parseClientDiagnostics(formText(form, 'clientDiagnostics')) : null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // The schema's own messages are written for people; zod's defaults are not.
      const message = issue && /^(Enter|Describe)/.test(issue.message)
        ? issue.message
        : `Check the ${String(issue?.path[0] ?? 'form')} field and try again.`;
      throw new ApiError('invalid_request', message, 400);
    }
    const attachments = await checkAttachments(formFiles(form, 'files'));
    const ticket = await createTicket(user.id, parsed.data, attachments, attachDiagnostics);
    log.info('support.ticket_created', { ticket: ticket.number, category: parsed.data.category });
    return Response.json(ticket, { status: 201 });
  } catch (error) {
    return supportError(error, requestId, log);
  }
}
