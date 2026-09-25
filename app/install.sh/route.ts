import { installerResponse } from '@/lib/setup/installers';

// Read per request so the served script always matches the deployed files.
export const dynamic = 'force-dynamic';

/** `curl -fsSL https://<site>/install.sh | sh` — Codex and Claude Code setup for macOS and Linux. */
export function GET(): Promise<Response> {
  return installerResponse('sh');
}
