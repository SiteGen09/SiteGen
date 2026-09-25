import { installerResponse } from '@/lib/setup/installers';

// Read per request so the served script always matches the deployed files.
export const dynamic = 'force-dynamic';

/** `curl -fsSL https://<site>/uninstall.sh | sh` — puts Codex and Claude Code back on macOS and Linux. */
export function GET(): Promise<Response> {
  return installerResponse('sh', 'uninstall');
}
