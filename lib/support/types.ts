/**
 * Support vocabulary shared by the dashboard, the admin portal and the server.
 * Browser-safe: no server imports.
 */

export const TICKET_CATEGORIES = [
  { value: 'setup', label: 'Setup' },
  { value: 'payment', label: 'Payment' },
  { value: 'api', label: 'API / endpoint' },
  { value: 'balance', label: 'Balance' },
  { value: 'account', label: 'Account' },
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature request' },
  { value: 'other', label: 'Other' },
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number]['value'];

export const TICKET_PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]['value'];

export const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const CATEGORY_VALUES = TICKET_CATEGORIES.map((entry) => entry.value) as [TicketCategory, ...TicketCategory[]];
export const PRIORITY_VALUES = TICKET_PRIORITIES.map((entry) => entry.value) as [TicketPriority, ...TicketPriority[]];

export function categoryLabel(value: string): string {
  return TICKET_CATEGORIES.find((entry) => entry.value === value)?.label ?? value;
}

export function priorityLabel(value: string): string {
  return TICKET_PRIORITIES.find((entry) => entry.value === value)?.label ?? value;
}

/** Customer-facing wording: "answered" means the ball is in their court. */
export function customerStatusLabel(status: string): string {
  if (status === 'open') return 'Waiting for support';
  if (status === 'answered') return 'Support replied';
  if (status === 'closed') return 'Closed';
  return status;
}

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
/** Screenshots, logs and config files. Nothing a browser would execute. */
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'application/json',
  'application/pdf',
] as const;
/** For the file picker; the server re-checks the actual type. */
export const ATTACHMENT_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.txt,.log,.json,.toml,.yaml,.yml,.md,.pdf';

export const SUBJECT_MAX = 160;
export const BODY_MAX = 10000;
export const CHAT_MESSAGE_MAX = 4000;

/** One assistant turn as the support page renders it. */
export interface SupportChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}
