import { z } from 'zod';

/**
 * Person-facing wording for dashboard chat and media failures.
 *
 * The `/v1` gateway keeps its terse developer messages, which API clients and
 * the docs depend on. The dashboard routes translate at their boundary instead,
 * so someone chatting sees what happened and what to do next rather than an
 * internal code, raw provider text or "unknown error". Browser-safe: the client
 * uses the same module for failures that never reach the server.
 */

export const CHAT_ERROR_KINDS = [
  'credits', 'rate_limit', 'paused', 'policy', 'session', 'account', 'model', 'busy',
  'too_large', 'provider', 'network', 'server', 'request', 'gone', 'interrupted', 'unsaved',
] as const;
export type ChatErrorKind = (typeof CHAT_ERROR_KINDS)[number];

export const chatErrorSchema = z.object({
  // An older client meeting a newer kind still renders the message.
  kind: z.enum(CHAT_ERROR_KINDS).catch('server'),
  title: z.string(),
  message: z.string(),
  request_id: z.string().optional(),
});
export type ChatError = z.infer<typeof chatErrorSchema>;

/** What the server knows about a failure, before it is worded for a person. */
export interface ErrorFacts {
  code: string;
  message: string;
  status: number;
  required?: number | undefined;
  balance?: number | undefined;
  retryAfter?: number | undefined;
}

function credits(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

function wait(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 1) return 'a moment';
  if (seconds < 90) return Math.ceil(seconds) + ' seconds';
  return Math.ceil(seconds / 60) + ' minutes';
}

/** Dashboard-authored messages are already sentences; normalize the rest. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Please check your message and try again.';
  const capitalized = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : capitalized + '.';
}

function creditMessage({ required, balance }: ErrorFacts): string {
  if (required === undefined || balance === undefined) {
    return 'Your credit balance is too low for this request. Add credits to continue.';
  }
  if (balance <= 0) {
    return `Your credit balance is empty, and this request needs up to ${credits(required)} credits. Add credits to continue.`;
  }
  return `This request needs up to ${credits(required)} credits, but your balance is ${credits(balance)}. ` +
    'Add credits, or try a shorter message or a less expensive model. Credits are reserved up front and anything unused is returned.';
}

export function describeError(facts: ErrorFacts): Omit<ChatError, 'request_id'> {
  const { code, message, status } = facts;
  switch (code) {
    case 'insufficient_credits':
      return { kind: 'credits', title: 'Not enough credits', message: creditMessage(facts) };
    case 'rate_limited':
      return /policy violation/i.test(message)
        ? { kind: 'paused', title: 'Generation is paused', message: 'Your account is temporarily paused after repeated content-policy violations. Please try again later.' }
        : { kind: 'rate_limit', title: 'Too many requests', message: `You're sending requests faster than your account allows. Wait ${wait(facts.retryAfter)} and try again.` };
    case 'unauthorized':
      return { kind: 'session', title: 'Session expired', message: 'Your session has ended. Sign in again to keep chatting.' };
    case 'forbidden':
      return /origin/i.test(message)
        ? { kind: 'request', title: 'Request blocked', message: 'This request was blocked for security reasons. Reload the page and try again.' }
        : { kind: 'account', title: 'Account unavailable', message: "Your account can't use chat or generation right now. Contact support if you think this is a mistake." };
    case 'content_policy_violation':
      return /provider/i.test(message)
        ? { kind: 'policy', title: 'Declined by the provider', message: "The AI provider declined this request under its content policy. Try rephrasing it." }
        : { kind: 'policy', title: 'Message not allowed', message: "This message can't be sent because it goes against the content policy. Please rephrase it and try again." };
    case 'model_not_found':
      return { kind: 'model', title: 'Model unavailable', message: "The selected model isn't available for your plan or routing settings. Choose another model, or switch to Auto." };
    case 'not_found':
      return { kind: 'gone', title: 'Conversation not found', message: 'This conversation no longer exists. Start a new chat to continue.' };
    case 'channel_unavailable': {
      const media = /\b(image|video) generation\b/i.exec(message);
      if (media) {
        const kind = media[1]!.toLowerCase();
        return { kind: 'model', title: 'Not available right now', message: `${kind[0]!.toUpperCase() + kind.slice(1)} generation isn't available right now. Please try again later.` };
      }
      if (/protection/i.test(message)) break;
      return { kind: 'provider', title: 'Model temporarily unavailable', message: "The AI provider for this model isn't responding right now. Try again in a moment, or choose a different model." };
    }
    case 'generation_failed':
      return { kind: 'provider', title: 'No usable reply', message: 'The model returned an empty or unreadable response. Please try again, or choose a different model.' };
    case 'invalid_request':
      if (/already answering/i.test(message)) {
        return { kind: 'busy', title: 'Still answering', message: 'This chat is still finishing another reply, possibly in another tab. Wait a moment and try again.' };
      }
      if (/character limit/i.test(message)) {
        return { kind: 'too_large', title: 'Conversation too long', message: 'This conversation is too long for the model to read. Start a new chat to continue.' };
      }
      if (status === 413 || /too large/i.test(message)) {
        return { kind: 'too_large', title: 'Message too large', message: 'Your message and attachments are too large to send. Remove an attachment or shorten the message.' };
      }
      if (/^the model rejected/i.test(message)) {
        return { kind: 'provider', title: "The model couldn't process this", message: 'Try shortening your message, removing attachments, or choosing a different model.' };
      }
      return { kind: 'request', title: "Can't send this message", message: sentence(message) };
  }
  return { kind: 'server', title: 'Something went wrong', message: 'Something went wrong on our side. Please try again in a moment.' };
}

/** Failures the browser sees without a JSON error body: offline, a proxy page, a platform limit. */
export function transportError(status?: number): ChatError {
  if (status === undefined) {
    return { kind: 'network', title: 'Connection problem', message: "Can't reach the server. Check your internet connection and try again." };
  }
  if (status === 401) return { ...describeError({ code: 'unauthorized', message: '', status }) };
  if (status === 413) return { ...describeError({ code: 'invalid_request', message: 'too large', status }) };
  if (status === 429) return { ...describeError({ code: 'rate_limited', message: '', status }) };
  if (status >= 502 && status <= 504) {
    return { kind: 'server', title: 'Server busy', message: 'The server took too long to respond. Please try again in a moment.' };
  }
  return { ...describeError({ code: 'internal_error', message: '', status }) };
}

export const INTERRUPTED: ChatError = {
  kind: 'interrupted',
  title: 'Connection interrupted',
  message: 'The connection dropped before the reply finished. Reload the conversation to see what was saved.',
};

/** The one next step worth a button, when there is one. */
export function errorAction(kind: ChatErrorKind): { label: string; href: string } | null {
  if (kind === 'credits') return { label: 'Add credits', href: '/dashboard/billing' };
  if (kind === 'session') return { label: 'Sign in', href: '/login' };
  return null;
}

/** A support reference only helps when the fault may be ours or the provider's. */
export function showsReference(kind: ChatErrorKind): boolean {
  return kind === 'server' || kind === 'provider' || kind === 'interrupted' || kind === 'unsaved';
}

/**
 * Whether sending the same turn again can succeed. An unsaved reply was
 * already billed, and account or policy refusals need a change first.
 */
export function canRetry(kind: ChatErrorKind): boolean {
  return !['unsaved', 'session', 'account', 'paused', 'gone', 'policy'].includes(kind);
}
