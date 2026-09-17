#!/usr/bin/env node
// Blocks credential-shaped strings from entering the repo.
// Run over staged files (pre-commit) or all tracked files (`--all`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { name: 'Stripe/platform live key', re: /sk_live_[0-9A-Za-z]{20,}/ },
  { name: 'Stripe test/restricted key', re: /(sk_test|rk_live)_[0-9A-Za-z]{20,}/ },
  { name: 'Stripe webhook secret', re: /whsec_[0-9A-Za-z]{24,}/ },
  { name: 'Anthropic API key', re: /sk-ant-api\d\d-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /sk-(proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'GitHub token', re: /(ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'JWT (service_role?)', re: /eyJhbGciOi[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const SKIP = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|scripts\/check-secrets\.mjs)$|^node_modules\/|\.(png|jpg|jpeg|gif|webp|ico|woff2?|pdf)$/;

const all = process.argv.includes('--all');
const files = execFileSync(
  'git',
  all ? ['ls-files'] : ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
  { encoding: 'utf8' }
)
  .split('\n')
  .filter((f) => f && !SKIP.test(f));

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, i) => {
    if (line.includes('check-secrets:allow')) return;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) hits.push({ file, line: i + 1, name });
    }
  });
}

if (hits.length) {
  console.error('\nPossible secrets detected — commit blocked:\n');
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.name}`);
  console.error(
    '\nUse a placeholder or read the value from the environment.' +
      '\nIf a match is genuinely safe, append the comment "check-secrets:allow" to that line.\n'
  );
  process.exit(1);
}
console.log(`check-secrets: clean (${files.length} files)`);
