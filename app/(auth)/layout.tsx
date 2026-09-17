import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '../theme-toggle';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-4 py-10 sm:py-16">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-6 block text-center text-sm font-semibold tracking-tight text-zinc-900 sm:mb-8"
        >
          sitegen
        </Link>
        <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">{children}</div>
        <div className="mt-6 flex justify-center">
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
