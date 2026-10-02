import nodemailer from 'nodemailer';

/**
 * Email to the operators, for alerts they must not miss while away from the
 * dashboard. Sent through the site's own mailbox over SMTP (SMTP_* in the
 * server environment) to ADMIN_ALERT_EMAIL, a comma-separated list.
 *
 * Consumer mail (sign-up, password reset) is sent by Supabase with its own
 * copy of these settings; this is only for administrators.
 */

export interface AdminEmail {
  subject: string;
  text: string;
}

interface MailConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  to: string[];
}

export function adminMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const port = Number(env.SMTP_PORT ?? 587);
  const to = (env.ADMIN_ALERT_EMAIL ?? '').split(',').map((address) => address.trim()).filter(Boolean);
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !Number.isInteger(port) || to.length === 0) return null;
  return { host: env.SMTP_HOST, port, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM || env.SMTP_USER, to };
}

/**
 * Sends one email to the administrators. Resolves false, never throws, when
 * mail is not configured or delivery fails: an alert email is a courtesy on
 * top of the dashboard notification, not a reason to fail the work that
 * raised it. Never sends under the test runner, which loads `.env.local`.
 */
export async function sendAdminEmail(email: AdminEmail, config = adminMailConfig()): Promise<boolean> {
  if (process.env.VITEST || config === null) return false;
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      requireTLS: config.port === 587,
      auth: { user: config.user, pass: config.password },
      connectionTimeout: 15_000,
      socketTimeout: 30_000,
    });
    await transport.sendMail({ from: config.from, to: config.to, subject: email.subject, text: email.text });
    return true;
  } catch {
    return false;
  }
}
