/**
 * How a media job is referenced from a chat turn.
 *
 * A marker rather than a URL because signed URLs expire: storing one would
 * render a broken image the next day. The client resolves the marker through
 * `/api/media/{id}`, which mints a fresh URL on every read.
 *
 * Dependency-free on purpose — the chat workspace is a client component, so
 * this must not drag in the Supabase service client that `jobs.ts` uses.
 */

const MARKER = /^\[\[media:([0-9a-f-]{36})\]\]$/;

export function mediaMarker(jobId: string): string {
  return `[[media:${jobId}]]`;
}

/** The job id inside a marker, or null when the text is an ordinary turn. */
export function parseMediaMarker(content: string): string | null {
  const match = MARKER.exec(content.trim());
  return match === null ? null : match[1]!;
}
