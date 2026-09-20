import { resolvePlatformCreds } from '@/lib/admin/credentials';

try {
  const creds = await resolvePlatformCreds('openai_compatible', 'http://localhost:11435/v1');
  console.log('ok', { provider: creds.provider, baseUrl: creds.baseUrl, keyLen: creds.apiKey.length });
} catch (err) {
  console.log('FAIL', err instanceof Error ? err.message : err);
}
