# gensite.tech domain and Titan Email setup

This release uses the following public identity:

- App: https://gensite.tech
- Transactional sender: contact@gensite.tech
- Support mailbox: admin@gensite.tech
- Supabase auth callback: https://gensite.tech/auth/callback

## 1. Create the Titan mailboxes

Create both mailboxes in Titan before configuring Supabase:

- contact@gensite.tech — SMTP sender for signup verification and password recovery.
- admin@gensite.tech — support address shown to customers and the mailbox for account or technical problems.

Use the full contact@gensite.tech address as the SMTP username. Keep its password in your password manager; do not commit it or add it to the repository.

## 2. Publish the DNS records

Use Titan's domain setup screen as the source of truth for the records it gives you. The exact DKIM host and value are unique to your Titan account. Add all of these at the DNS provider that hosts gensite.tech:

- Titan's MX records (Titan commonly supplies mx1.titan.email and mx2.titan.email; use the priorities shown in your Titan dashboard).
- Titan's SPF TXT record (use Titan's exact include value; do not publish two separate SPF records).
- Titan's DKIM record or records, copied exactly from Titan.
- A DMARC TXT record at _dmarc.gensite.tech. Start with v=DMARC1; p=none; rua=mailto:admin@gensite.tech; adkim=s; aspf=s, monitor reports, then tighten the policy after delivery is confirmed.

Do not remove Vercel's app records while adding mail records. The apex and www records are separate from MX, SPF, DKIM, and DMARC.

## 3. Attach the app domain

In Vercel, add gensite.tech to the project and follow the DNS values Vercel displays. Make the apex domain canonical and redirect www.gensite.tech to it if you add www as an alias. Wait for Vercel to issue the HTTPS certificate.

Set these production variables in Vercel before building:

NEXT_PUBLIC_APP_URL=https://gensite.tech
NEXT_PUBLIC_SUPPORT_EMAIL=admin@gensite.tech

NEXT_PUBLIC values are public and are inlined into the browser bundle. Never put an SMTP password, Supabase service-role key, or other secret in a NEXT_PUBLIC variable.

## 4. Configure hosted Supabase Auth

In Supabase → Authentication → URL Configuration:

- Site URL: https://gensite.tech
- Redirect URL: https://gensite.tech/auth/callback

In Authentication → SMTP settings, use the Titan values from your account. Titan commonly uses:

- Host: smtp.titan.email
- Port: 587 with STARTTLS
- Username: contact@gensite.tech
- Sender email: contact@gensite.tech
- Sender name: gensite

Enter the Titan password only in the Supabase dashboard. If Titan shows a different host, port, or encryption mode for your account, use Titan's values.

In Authentication → Email Templates, copy these repository templates:

- Confirmation: supabase/templates/confirmation.html; subject: Your sitegen verification code
- Recovery: supabase/templates/recovery.html; subject: Reset your sitegen password

Keep the Supabase template variables {{ .Token }} and {{ .ConfirmationURL }} intact. Signup uses the six-digit token; password recovery accepts the token or the secure link.

Set email confirmation on, six-digit OTP, 10-minute expiry, and a 60-second resend interval. Use admin@gensite.tech as the support address in any available notification field.

## 5. Verify the complete mail flow

After DNS and SMTP changes propagate:

1. Open https://gensite.tech/signup and request a verification code.
2. Confirm that it arrives from contact@gensite.tech and complete signup.
3. Open https://gensite.tech/forgot-password, request a code, and test both the code and reset-link paths.
4. Reply to a test support message sent to admin@gensite.tech.
5. Check SPF, DKIM, and DMARC results in the received message headers.

The repository includes the forgot-password UI and reset route. The hosting and Supabase dashboard settings above are still required for the messages to leave Titan.

If you will serve the complete Next.js app from your local computer through Cloudflare Tunnel instead of Vercel, follow [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md).
