import { installerResponse } from '@/lib/setup/installers';

// Read per request so the served script always matches the deployed files.
export const dynamic = 'force-dynamic';

/** `irm https://<site>/install.ps1 | iex` — Codex and Claude Code setup for Windows. */
export function GET(): Promise<Response> {
  return installerResponse('ps1');
}
