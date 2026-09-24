'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

export function CheckoutModal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-auto max-h-[94dvh] w-[min(96vw,56rem)] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/75"
    >
      <div className="flex max-h-[94dvh] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-zinc-800 px-4 py-3 sm:px-6">
          <h2 id={titleId} className="font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800" aria-label="Close checkout">Close</button>
        </header>
        <div className="overflow-y-auto p-4 sm:p-6">{children}</div>
      </div>
    </dialog>
  );
}
