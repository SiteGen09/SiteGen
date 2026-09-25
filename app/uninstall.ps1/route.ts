import { installerResponse } from '@/lib/setup/installers';

// Read per request so the served script always matches the deployed files.
export const dynamic = 'force-dynamic';

/** `irm https://<site>/uninstall.ps1 | iex` — puts Codex and Claude Code back on Windows. */
export function GET(): Promise<Response> {
  return installerResponse('ps1', 'uninstall');
}
