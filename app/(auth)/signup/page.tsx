import Link from 'next/link';
import { SignupForm } from './signup-form';

export const metadata = { title: 'Create account — sitegen' };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-lg font-semibold text-zinc-900">Create account</h1>
      <p className="mt-1 text-sm text-zinc-500">Free to start. No card required.</p>
      <SignupForm />
      <p className="mt-6 text-sm text-zinc-500">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-zinc-900 underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
