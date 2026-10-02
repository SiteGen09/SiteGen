/**
 * Sends one test email to ADMIN_ALERT_EMAIL through the same code the server
 * uses for admin alerts, to check the SMTP_* settings after changing them.
 *
 *   pnpm exec tsx scripts/send-test-admin-email.mts
 */
import { config } from 'dotenv';
import { adminMailConfig, sendAdminEmail } from '../lib/email/admin';
config({ path: '.env.local', quiet: true });

const mail = adminMailConfig();
if (!mail) throw new Error('Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and ADMIN_ALERT_EMAIL in .env.local');
const sent = await sendAdminEmail({
  subject: '[gensite] Test: admin alerts are set up',
  text: `This test came through the server's alert email code.\n\nProvider-failure alerts will be sent from ${mail.from} to ${mail.to.join(', ')}.\n\nNo action needed.`,
}, mail);
console.log(sent ? `Sent to ${mail.to.join(', ')}.` : 'Not sent: check the SMTP settings and the server log.');
process.exit(sent ? 0 : 1);
