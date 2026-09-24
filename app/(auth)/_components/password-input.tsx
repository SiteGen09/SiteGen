'use client';

import { useState, type InputHTMLAttributes } from 'react';

export const authInputClass = 'min-h-11 w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-500/15 disabled:opacity-60 read-only:bg-zinc-50';

export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input {...props} type={visible ? 'text' : 'password'} className={`${authInputClass} pr-12`} />
      <button type="button"
        aria-label={`${visible ? 'Hide' : 'Show'} ${props.name === 'confirmPassword' ? 'confirm password' : 'password'}`}
        aria-pressed={visible} aria-controls={props.id} disabled={props.disabled}
        onClick={() => setVisible(!visible)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-zinc-500 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-zinc-500">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {visible ? <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> : <><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 4M6.1 6.1A21 21 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.9-1.9M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>}
        </svg>
      </button>
    </div>
  );
}
