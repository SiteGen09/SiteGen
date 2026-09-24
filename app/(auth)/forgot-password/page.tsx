import Link from 'next/link';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata = { title: 'Reset your password — sitegen' };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Reset your password</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">Enter your account email and we’ll send a six-digit code. You can also use the secure reset link in that email.</p>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-sm text-zinc-500"><Link href="/login" className="font-medium text-zinc-900 underline underline-offset-2">Back to sign in</Link></p>
    </>
  );
}
