import { afterEach, describe, expect, it, vi } from 'vitest';

import { installerBaseUrl, installerResponse, installerScript } from './installers';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installerScript', () => {
  it.each(['ps1', 'sh'] as const)('writes the site address into every placeholder of install.%s', async (kind) => {
    const script = await installerScript(kind, 'https://gensite.tech');
    expect(script).not.toContain('__SITEGEN_BASE_URL__');
    expect(script).toContain('https://gensite.tech/install.');
  });

  it('serves the shell script with LF line endings only', async () => {
    const script = await installerScript('sh', 'https://gensite.tech');
    expect(script).not.toContain('\r');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('keeps the shell script runnable from a partial download', async () => {
    // Everything happens inside main(), which is only called on the last line.
    const script = await installerScript('sh', 'https://gensite.tech');
    expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
  });

  it('keeps the PowerShell script in its own scope, so iex leaves no variables behind', async () => {
    const script = await installerScript('ps1', 'https://gensite.tech');
    const code = script.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(code[0]).toBe('& {');
    expect(code[code.length - 1]).toBe('}');
  });
});

describe('installerBaseUrl', () => {
  it('uses the configured site address without a trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://gensite.tech/');
    expect(installerBaseUrl()).toBe('https://gensite.tech');
  });

  it.each([
    'https://gensite.tech"; rm -rf ~; "',
    "https://gensite.tech'",
    'javascript:alert(1)',
    'https://gensite.tech/$(id)',
  ])('refuses an address that could break out of the scripts: %s', (url) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', url);
    expect(() => installerBaseUrl()).toThrow();
  });
});

describe('installerResponse', () => {
  it('serves plain text that PowerShell reads as a string', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://gensite.tech');
    const response = await installerResponse('ps1');
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toContain("$BaseUrl = 'https://gensite.tech'");
  });
});
