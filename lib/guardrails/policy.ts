/** Conservative local rules, not a semantic safety classifier. */
export function policyText(value: unknown, depth = 0): string {
  if (depth > 20 || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return '';
  return Object.values(value).map(item => policyText(item, depth + 1)).join('\n');
}

export function localPolicy(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').toLowerCase();
  // Explicit creation requests only. Discussion/prevention must not be blocked
  // just for mentioning a sensitive topic.
  const request = /(?:^|[\n.!?]\s*)(?:please\s+)?(?:create|generate|make|write|draw|produce)\s+(?:me\s+)?(?:an?\s+)?/g;
  for (const match of normalized.matchAll(request)) {
    const tail = normalized.slice(match.index + match[0].length, match.index + match[0].length + 180);
    if (/^(?:child porn(?:ography)?|csam)\s+(?:prevention|awareness|reporting|detection|education)\b/.test(tail)) continue;
    if (/^(?:child porn(?:ography)?|csam)\b/.test(tail) ||
        /^(?:sexually explicit|pornographic|nude)\s+(?:images?|photos?|videos?|pictures?)\s+of\s+(?:(?:a|an)\s+)?(?:children|child|minor|underage)\b/.test(tail)) return ['local/child-exploitation-request'];
    if (/^(?:ransomware|credential[ -]stealing malware|password[ -]stealing malware)\s+(?:that|to)\s+(?:steal|encrypt|extort|infect)\b/.test(tail)) return ['local/malware-request'];
  }
  return [];
}

const POLICY_CODES = new Set(['content_policy_violation', 'content_filter', 'content-filter', 'content_filtered', 'safety_violation', 'moderation_blocked', 'responsibleaipolicyviolation']);
/** Only explicit machine codes or rejection wording; never a generic 403/422. */
export function isPolicyRejection(error: unknown, depth = 0): boolean {
  if (depth > 5 || error === null || typeof error !== 'object') return false;
  const e = error as Record<string, unknown>;
  for (const key of ['code', 'type', 'errorCode', 'finishReason']) {
    if (typeof e[key] === 'string' && POLICY_CODES.has(e[key].toLowerCase())) return true;
  }
  if (typeof e.message === 'string' && /(?:blocked|rejected|flagged|violates|violated)\b.{0,80}\b(?:content policy|safety policy|safety filter|moderation)|\b(?:content policy|safety policy|safety filter|moderation)\b.{0,80}\b(?:violation|blocked|rejected)/i.test(e.message)) return true;
  if (typeof e.responseBody === 'string' && e.responseBody.length < 65536) {
    try { if (isPolicyRejection(JSON.parse(e.responseBody), depth + 1)) return true; } catch { /* Not a JSON error envelope. */ }
  }
  return isPolicyRejection(e.error, depth + 1) || isPolicyRejection(e.cause, depth + 1) ||
    (Array.isArray(e.errors) && e.errors.some(item => isPolicyRejection(item, depth + 1)));
}
