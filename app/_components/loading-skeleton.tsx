import type { ReactNode } from 'react';

type SkeletonProps = {
  className?: string;
  dark?: boolean;
};

export function LoadingSpinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <span aria-hidden="true" className={`loading-spinner ${className}`} />;
}

function Skeleton({ className = '', dark = false }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={['skeleton', dark ? 'skeleton-on-dark' : '', className].filter(Boolean).join(' ')}
    />
  );
}

function LoadingFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className={className}>
      <span className="sr-only">Loading</span>
      {children}
    </div>
  );
}

function SkeletonLines({ count = 3, dark = false }: { count?: number; dark?: boolean }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          dark={dark}
          className={index === count - 1 ? 'h-4 w-2/3' : 'h-4 w-full'}
        />
      ))}
    </div>
  );
}

export function PublicPageLoading() {
  return (
    <LoadingFrame className="min-h-full bg-zinc-50 px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 flex flex-wrap items-center justify-between gap-4">
          <Skeleton className="h-8 w-28" />
          <div className="flex gap-5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>

        <Skeleton className="h-10 w-64" />
        <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
        <Skeleton className="mt-2 h-4 w-4/5 max-w-xl" />

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="rounded-lg border border-zinc-200 bg-white p-5">
              <Skeleton className="h-5 w-2/5" />
              <SkeletonLines count={3} />
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-5">
          <Skeleton className="h-5 w-1/3" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-4 border-b border-zinc-100 pb-3 last:border-0">
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </LoadingFrame>
  );
}

export function DashboardPageLoading() {
  return (
    <LoadingFrame className="space-y-6">
      <header>
        <Skeleton className="h-7 w-36" />
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-8 w-32" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <div className="flex gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-3">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-3 flex-1" />
            ))}
          </div>
          <div className="space-y-4 px-4 py-4">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="flex items-center gap-4">
                {Array.from({ length: 4 }, (_, cell) => (
                  <Skeleton key={cell} className={cell === 2 ? 'h-4 flex-[1.5]' : 'h-4 flex-1'} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </LoadingFrame>
  );
}

export function AdminPageLoading() {
  return (
    <LoadingFrame className="space-y-6">
      <header>
        <Skeleton dark className="h-7 w-36" />
        <Skeleton dark className="mt-2 h-4 w-96 max-w-full" />
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
            <Skeleton dark className="h-3 w-20" />
            <Skeleton dark className="mt-4 h-8 w-24" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-4">
          <Skeleton dark className="h-5 w-40" />
          <Skeleton dark className="h-8 w-24" />
        </div>
        <div className="mt-5 space-y-4">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton dark className="h-4 w-1/4" />
              <Skeleton dark className="h-4 flex-1" />
              <Skeleton dark className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </LoadingFrame>
  );
}

export function AuthPageLoading() {
  return (
    <LoadingFrame className="space-y-5">
      <Skeleton className="h-8 w-36" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className="space-y-4 pt-3">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="mx-auto h-4 w-32" />
      </div>
    </LoadingFrame>
  );
}
