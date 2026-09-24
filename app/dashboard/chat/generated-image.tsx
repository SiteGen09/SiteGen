'use client';

import { useEffect, useRef, useState } from 'react';

const actionClass = 'inline-flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-[#fff] shadow-sm backdrop-blur-sm transition hover:bg-black/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#fff]';

function DownloadLink({ jobId }: { jobId: string }) {
  return (
    <a
      href={`/api/media/${encodeURIComponent(jobId)}?download=1`}
      download
      aria-label="Download image"
      title="Download image"
      className={actionClass}
    >
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5" />
      </svg>
    </a>
  );
}

export function GeneratedImage({ jobId, url }: { jobId: string; url: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);

  return (
    <>
      <div className="relative w-fit max-w-full">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Expand image"
          aria-haspopup="dialog"
          title="Expand image"
          className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-700"
        >
          {/* Signed storage URLs are temporary and cannot use the image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Generated image" className="block max-h-96 max-w-full object-contain" />
        </button>
        <div className="absolute right-2 top-2">
          <DownloadLink jobId={jobId} />
        </div>
      </div>

      <dialog
        ref={dialogRef}
        aria-label="Image preview"
        onClose={() => setExpanded(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setExpanded(false);
        }}
        className="m-auto max-h-[94dvh] max-w-[94vw] overflow-visible rounded-xl border-0 bg-transparent p-0 backdrop:bg-black/85 backdrop:backdrop-blur-sm"
      >
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Generated image, expanded preview" className="block max-h-[90dvh] max-w-[94vw] rounded-xl object-contain shadow-2xl" />
          <div className="absolute right-3 top-3 flex gap-2">
            <DownloadLink jobId={jobId} />
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Close image preview"
              title="Close preview (Esc)"
              autoFocus
              className={actionClass}
            >
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
