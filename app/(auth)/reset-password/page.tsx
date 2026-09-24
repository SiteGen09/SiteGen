import Link from 'next/link';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = { title: 'Choose a new password — sitegen' };

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Choose a new password</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">Set a new password for your sitegen account.</p>
      <ResetPasswordForm />
      <p className="mt-6 text-center text-sm text-zinc-500"><Link href="/forgot-password" className="font-medium text-zinc-900 underline underline-offset-2">Request another reset code</Link></p>
    </>
  );
}
