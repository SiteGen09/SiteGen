import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type InstallerKind = 'ps1' | 'sh';
export type InstallerAction = 'install' | 'uninstall';

const FILES: Record<InstallerKind, string> = { ps1: 'install.ps1', sh: 'install.sh' };

/** Where each script names the server it configures clients for. */
const BASE_URL_PLACEHOLDER = '__SITEGEN_BASE_URL__';
/** What a script does when run without SITEGEN_ACTION or --uninstall. */
const ACTION_PLACEHOLDER = '__SITEGEN_DEFAULT_ACTION__';

/**
 * The address written into the scripts. It comes from configuration, never
 * from the request, so a forged Host header cannot make the site hand out a
 * script that sends keys elsewhere. It is also held to a plain origin (with an
 * optional path) because it lands inside quoted strings in both scripts.
 */
export function installerBaseUrl(): string {
  const url = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+)*$/.test(url)) {
    throw new Error(`NEXT_PUBLIC_APP_URL is not a plain http(s) address: ${url}`);
  }
  return url;
}

/**
 * The setup script for one platform with this site's address written in, so a
 * copy fetched from staging configures clients for staging. The undo routes
 * serve the same script with `uninstall` as its default action, so one short
 * command reverts everything. The shell script is served with LF line endings
 * whatever the checkout used: `sh` cannot run CRLF.
 */
export async function installerScript(
  kind: InstallerKind,
  baseUrl: string,
  action: InstallerAction = 'install',
): Promise<string> {
  const raw = await readFile(path.join(process.cwd(), 'installers', FILES[kind]), 'utf8');
  const text = kind === 'sh' ? raw.replace(/\r\n/g, '\n') : raw;
  return text.replaceAll(BASE_URL_PLACEHOLDER, baseUrl).replaceAll(ACTION_PLACEHOLDER, action);
}

/** Plain text, so `irm` returns a string and a browser shows the script to read. */
export async function installerResponse(kind: InstallerKind, action: InstallerAction = 'install'): Promise<Response> {
  const body = await installerScript(kind, installerBaseUrl(), action);
  const filename = `${action}.${kind}`;
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `inline; filename="${filename}"`,
      // Short, so a fixed script reaches everyone within minutes of a deploy.
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
