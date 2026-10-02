import { describe, expect, it } from 'vitest';

import { adminMailConfig, sendAdminEmail } from './admin';

const env = {
  SMTP_HOST: 'smtp.titan.email', SMTP_PORT: '587', SMTP_USER: 'admin@gensite.tech', SMTP_PASSWORD: 'x',
  SMTP_FROM: 'gensite <admin@gensite.tech>', ADMIN_ALERT_EMAIL: 'ops@example.test, second@example.test',
} as unknown as NodeJS.ProcessEnv;

describe('adminMailConfig', () => {
  it('reads the SMTP settings and a comma-separated recipient list', () => {
    expect(adminMailConfig(env)).toMatchObject({ host: 'smtp.titan.email', port: 587, from: 'gensite <admin@gensite.tech>', to: ['ops@example.test', 'second@example.test'] });
  });

  it('falls back to the login as the sender', () => {
    expect(adminMailConfig({ ...env, SMTP_FROM: '' })?.from).toBe('admin@gensite.tech');
  });

  it('is off without a password or a recipient', () => {
    expect(adminMailConfig({ ...env, SMTP_PASSWORD: '' })).toBeNull();
    expect(adminMailConfig({ ...env, ADMIN_ALERT_EMAIL: ' , ' })).toBeNull();
  });
});

describe('sendAdminEmail', () => {
  it('never sends under the test runner', async () => {
    expect(await sendAdminEmail({ subject: 's', text: 't' }, adminMailConfig(env))).toBe(false);
  });
});
