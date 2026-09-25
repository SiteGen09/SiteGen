import type { FilePart, TextPart } from 'ai';

import { ApiError } from '@/lib/api/errors';

/**
 * An image or document a client attached to a message, in whichever wire
 * format it arrived. `data` is a `data:` URL or an http(s) URL. Set by the
 * wire translators only; never read from a request body directly.
 */
export interface ChatAttachment {
  data: string;
  mediaType: string;
  filename?: string;
}

/** Coarse per-attachment allowance for the credit hold, as the dashboard chat uses. */
export const ATTACHMENT_CHAR_ESTIMATE = 8000;

/** Enough for a long agent session full of screenshots, not enough to abuse. */
export const MAX_ATTACHMENTS = 40;

const DATA_URL = /^data:([^;,]+)?((?:;[^;,=]+=[^;,]+)*)(;base64)?,(.*)$/s;

/** Media types forwarded as text rather than as a file part. */
function isTextType(mediaType: string): boolean {
  return /^text\//i.test(mediaType) || /^application\/(?:json|xml|x-yaml|yaml|csv|javascript|typescript)$/i.test(mediaType);
}

/** Only the kinds every upstream handles: images, PDFs and plain-text documents. */
function isSupportedType(mediaType: string): boolean {
  return /^image\//i.test(mediaType) || mediaType.toLowerCase() === 'application/pdf' || isTextType(mediaType);
}

function invalid(message: string): never {
  throw new ApiError('invalid_request', message, 400);
}

function mediaTypeFromName(filename: string | undefined): string | undefined {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'txt': case 'md': case 'log': return 'text/plain';
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    default: return undefined;
  }
}

/**
 * Builds an attachment from a `data:` URL or an http(s) URL. `mediaType`
 * (when the wire format carries one) wins over the URL's own, then the
 * filename's extension; an image URL with no type at all is assumed an image.
 */
export function attachmentFromUrl(
  url: string,
  options: { mediaType?: string; filename?: string; kind?: 'image' | 'file' } = {},
): ChatAttachment {
  const filename = options.filename || undefined;
  const data = DATA_URL.exec(url);
  if (data !== null) {
    const mediaType = options.mediaType ?? data[1] ?? mediaTypeFromName(filename);
    if (mediaType === undefined) invalid('an attached file has no media type');
    if (!isSupportedType(mediaType)) invalid(`attachments of type ${mediaType} are not supported; send images, PDFs or text files`);
    // Normalise to base64 so every consumer can rely on one encoding.
    const body = data[4] ?? '';
    const base64 = data[3] !== undefined ? body : Buffer.from(decodeURIComponent(body), 'utf8').toString('base64');
    return { data: `data:${mediaType};base64,${base64}`, mediaType, ...(filename ? { filename } : {}) };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('an attachment URL must be a data: URL or an http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    invalid('an attachment URL must be a data: URL or an http(s) URL');
  }
  const mediaType = options.mediaType ?? mediaTypeFromName(filename ?? parsed.pathname)
    ?? (options.kind === 'image' ? 'image/*' : undefined);
  if (mediaType === undefined) invalid('an attached file URL needs a media type or a file extension');
  if (!isSupportedType(mediaType)) invalid(`attachments of type ${mediaType} are not supported; send images, PDFs or text files`);
  return { data: parsed.toString(), mediaType, ...(filename ? { filename } : {}) };
}

/** Builds an attachment from raw base64 plus its media type. */
export function attachmentFromBase64(base64: string, mediaType: string, filename?: string): ChatAttachment {
  return attachmentFromUrl(`data:${mediaType};base64,${base64}`, { mediaType, filename });
}

/** Builds an attachment from inline text (an Anthropic plain-text document). */
export function attachmentFromText(text: string, filename?: string): ChatAttachment {
  return attachmentFromBase64(Buffer.from(text, 'utf8').toString('base64'), 'text/plain', filename);
}

/** A clear refusal for a reference to a file uploaded to someone else's API. */
export function unsupportedFileId(): never {
  return invalid('file_id references are not supported by this gateway; send the file inline as base64 or a data: URL');
}

/** The decoded text of a text document, or null for an image, PDF or remote file. */
export function attachmentText(attachment: ChatAttachment): string | null {
  if (!isTextType(attachment.mediaType) || !attachment.data.startsWith('data:')) return null;
  return Buffer.from(attachment.data.slice(attachment.data.indexOf(',') + 1), 'base64').toString('utf8');
}

/** Characters an attachment adds to the coarse hold estimate. */
export function attachmentChars(attachment: ChatAttachment): number {
  return attachmentText(attachment)?.length ?? ATTACHMENT_CHAR_ESTIMATE;
}

/**
 * Model message parts for a set of attachments. Text documents are inlined
 * (OpenAI-compatible upstreams reject text file parts); images and PDFs go as
 * file parts, which each provider maps to its own image or document block.
 */
export function attachmentParts(attachments: readonly ChatAttachment[]): Array<TextPart | FilePart> {
  return attachments.map((attachment) => {
    const text = attachmentText(attachment);
    if (text !== null) {
      const name = attachment.filename ?? 'attached file';
      return { type: 'text', text: `\n\n<file name="${name}">\n${text}\n</file>` };
    }
    if (attachment.data.startsWith('data:')) {
      return {
        type: 'file',
        data: { type: 'data', data: attachment.data.slice(attachment.data.indexOf(',') + 1) },
        mediaType: attachment.mediaType,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      };
    }
    return {
      type: 'file',
      data: { type: 'url', url: new URL(attachment.data) },
      mediaType: attachment.mediaType,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
    };
  });
}

/** Rejects a request carrying more attachments than a single call may. */
export function checkAttachmentCount(count: number): void {
  if (count > MAX_ATTACHMENTS) {
    invalid(`this request carries ${count} images or files; at most ${MAX_ATTACHMENTS} are accepted per request`);
  }
}
