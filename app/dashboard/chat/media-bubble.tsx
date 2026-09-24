'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { isPolicyRejection } from '@/lib/guardrails/policy';
import { GenerationProgress } from './generation-progress';
import { GeneratedImage } from './generated-image';

/**
 * Renders one media job inside the transcript.
 *
 * A job is asynchronous and long — a minute for an image, longer for video —
 * so this polls rather than waiting on the request that started it. That also
 * means a reload mid-render picks the job back up instead of losing it: the
 * transcript stores a marker, and every mount resolves that marker afresh.
 *
 * The URL is signed and expires, which is why it is fetched on mount rather
 * than stored with the message.
 */

const jobSchema = z.object({
  kind: z.enum(['image', 'video']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  created_at: z.string().optional(),
  url: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string().nullable() }).optional(),
});

type Job = z.infer<typeof jobSchema>;

/** Slow enough not to hammer the route, fast enough to feel live. */
const POLL_MS = 4000;

/** Roughly ten minutes. Past this the sweep has almost certainly closed the job. */
const MAX_POLLS = 150;

export function MediaBubble({ jobId, startedAt }: { jobId: string; startedAt: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [failed, setFailed] = useState('');

  useEffect(() => {
    let active = true;
    let polls = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function check(): Promise<void> {
      try {
        const response = await fetch(`/api/media/${jobId}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load this render.');
        const parsed = jobSchema.parse(await response.json());
        if (!active) return;
        setJob(parsed);
        if (parsed.status === 'succeeded' || parsed.status === 'failed') return;
        if ((polls += 1) >= MAX_POLLS) {
          setFailed('This render is taking unusually long. Reload to check again.');
          return;
        }
        pollTimer = setTimeout(() => void check(), POLL_MS);
      } catch (err) {
        if (active) setFailed(err instanceof Error ? err.message : 'Could not load this render.');
      }
    }

    void check();
    return () => {
      active = false;
      clearTimeout(pollTimer);
      controller.abort();
    };
  }, [jobId]);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {failed}
      </p>
    );
  }

  if (job === null || job.status === 'queued' || job.status === 'running') {
    const label = job?.kind === 'video' ? 'Rendering video' : 'Generating image';
    return (
      <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
        <GenerationProgress startedAt={job?.created_at ?? startedAt} label={label} />
        <p className="text-xs text-zinc-500">This usually takes a minute or two. Credits are only charged when it finishes.</p>
      </div>
    );
  }

  if (job.status === 'failed') {
    // Provider text is often an internal status line; the stored code is for support.
    const declined = isPolicyRejection(job.error);
    return (
      <div role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
        <p className="font-medium text-red-900">{declined ? 'Declined by the provider' : `This ${job.kind} couldn't be created`}</p>
        <p className="mt-1 leading-6">
          {declined
            ? 'The AI provider declined this prompt under its content policy. Try rephrasing it.'
            : "The provider couldn't finish this render. Try again, or choose a different model."}{' '}
          Your credits were returned.
        </p>
      </div>
    );
  }

  if (job.url === undefined) {
    return <p className="text-sm text-zinc-500">This render is no longer available.</p>;
  }

  return job.kind === 'video' ? (
    <video
      controls
      preload="metadata"
      src={job.url}
      className="max-h-96 w-full rounded border border-zinc-200"
    />
  ) : (
    <GeneratedImage jobId={jobId} url={job.url} />
  );
}
