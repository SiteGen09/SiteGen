# Account signup and sign-in

Email signup collects a username, an 8–20 character password, matching confirmation, and an email address. **Send code** registers a pending Supabase user with `user_metadata.username`. **Create account** verifies the six-digit email code before opening a session. Codes expire after 10 minutes and can be resent after 60 seconds. Supabase enforces email confirmation and rate limits; the browser never generates or stores verification codes.

The username is display metadata; email remains the password sign-in identifier. Google signup and sign-in use the same **Continue with Google** button and `/auth/callback` session exchange. Google supplies the verified email, so that path does not ask for a separate email code or password.

## Local email verification

The settings in `supabase/config.toml` enable email confirmation, set the password minimum to 8, and use `supabase/templates/confirmation.html`. Restart the existing local stack after changing auth configuration:

```powershell
supabase stop
supabase start
```

Do not use `--no-backup` or reset the database. The normal restart preserves data.

Local mail is captured by Mailpit at <http://127.0.0.1:54324>. It does **not** deliver to real inboxes. Use a new test email on `/signup`, click **Send code**, copy the code from Mailpit, then click **Create account**. An incorrect/expired code must leave the visitor signed out; an unconfirmed account must not be able to sign in with its password.

Run `pnpm exec tsx scripts/verify-auth.mts` to check real local email delivery, verification, password login, rate limiting and code reuse. It uses a unique disposable account and removes that account and its captured email afterwards. The auth regression tests run with `pnpm exec vitest run lib/auth app/auth/callback/route.test.ts`.

## Sending to real email addresses

For a hosted Supabase project (production values for this deployment are in [DOMAIN_EMAIL_SETUP.md](./DOMAIN_EMAIL_SETUP.md)):

1. Enable **Confirm email** in Authentication → Sign In / Providers → Email. Set the password minimum to 8, OTP length to 6, OTP expiry to 600 seconds, and resend interval to 60 seconds.
2. Set **Confirm signup** in Authentication → Email Templates to the contents of `supabase/templates/confirmation.html`, with subject `Your sitegen verification code`. Retain `{{ .Token }}`; a confirmation-link-only template will not provide the code expected by this form.
3. Configure your SMTP provider and a verified sender/domain. Supabase's default mail service is restricted and is not intended for public signup. Set appropriate production email rate limits for your sender.
4. Set the Site URL to your public HTTPS origin and allow its exact `/auth/callback` URL in Authentication → URL Configuration.

For local/self-hosted delivery to real inboxes, configure the `[auth.email.smtp]` section with your SMTP service and a secret from the environment, then restart auth. Do not commit SMTP passwords.

## Activating Google

Create a **Web application** OAuth client in Google Cloud. Configure the consent screen and add test users while the app is in testing. Set its authorized redirect URI to the Supabase callback:

- Local: `http://127.0.0.1:54321/auth/v1/callback`
- Hosted: `https://<project-ref>.supabase.co/auth/v1/callback`

For hosted Supabase, enable Google in Authentication → Sign In / Providers and enter the client ID and secret there. For local development, set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` in the shell environment used to start Supabase (or an ignored root `.env` read by its CLI), set `[auth.external.google].enabled = true`, and restart the local stack. Next's `.env.local` is not automatically loaded by the Supabase CLI.

Keep `email_optional = false` and nonce validation enabled. Do not put the Google client secret in a `NEXT_PUBLIC_*` variable. The app reads Supabase's public provider settings when the Google button is clicked, and shows a useful message if Google has not been activated yet.

The checked-in callback allowlist covers port 3000 and 3001 on localhost and 127.0.0.1. Add your exact origin when using another port. A Google callback failure or cancellation returns to the sign-in form and preserves a safe local destination.
