import { ApiError } from '@/lib/api/errors';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './types';

/** A file checked for size and real content type, ready to store. */
export interface CheckedAttachment {
  filename: string;
  mediaType: (typeof ATTACHMENT_TYPES)[number];
  data: Buffer;
}

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'toml', 'yaml', 'yml', 'md', 'ini', 'cfg', 'conf', 'env']);

function startsWith(data: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

/**
 * Decides the stored type from the bytes, not from what the browser claimed,
 * so a renamed HTML or SVG file cannot be served back as something a browser
 * would render or run.
 */
function sniff(filename: string, data: Buffer): CheckedAttachment['mediaType'] | null {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  if (extension !== 'json' && !TEXT_EXTENSIONS.has(extension)) return null;
  if (data.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
  return extension === 'json' ? 'application/json' : 'text/plain';
}

function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return cleaned === '' ? 'file' : cleaned;
}

export async function checkAttachments(files: readonly File[]): Promise<CheckedAttachment[]> {
  const real = files.filter((file) => file.size > 0);
  if (real.length > MAX_ATTACHMENTS) {
    throw new ApiError('invalid_request', `Attach up to ${MAX_ATTACHMENTS} files.`, 400);
  }
  const checked: CheckedAttachment[] = [];
  for (const file of real) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new ApiError('invalid_request', `${cleanFilename(file.name)} is larger than 4 MB.`, 400);
    }
    const data = Buffer.from(await file.arrayBuffer());
    const mediaType = sniff(file.name, data);
    if (mediaType === null) {
      throw new ApiError(
        'invalid_request',
        `${cleanFilename(file.name)} is not a supported file. Attach screenshots (PNG, JPG, GIF, WebP), PDFs, or text files such as logs and configs.`,
        400,
      );
    }
    checked.push({ filename: cleanFilename(file.name), mediaType, data });
  }
  return checked;
}
