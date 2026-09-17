import type { GenerateRequest } from '@/lib/generate/request';

/**
 * System instruction for spec generation. Constrains the model to the output
 * contract enforced by `siteSpecSchema` and to production-quality, on-brief
 * copy rather than placeholder text.
 */
export const SPEC_SYSTEM_PROMPT = [
  'You are a senior product designer and copywriter generating a complete,',
  'production-quality marketing website specification for a real business.',
  'Return a single site spec that conforms exactly to the provided schema.',
  'Requirements:',
  '- Write specific, benefit-driven copy grounded in the brief. Never use lorem',
  '  ipsum, placeholder text, or generic filler.',
  '- Choose sections that suit the business; every page needs at least one and',
  '  at most twelve sections, ordered as a visitor would read them.',
  '- Keep all identifiers and slugs kebab-case, and page slugs unique.',
  '- Never emit HTML tags or angle brackets in any text field.',
  '- Match the requested output language for all human-readable copy.',
].join('\n');

/** Builds the user prompt for a spec generation from the validated brief. */
export function buildSpecPrompt(request: GenerateRequest): string {
  const lines = [
    `Business name: ${request.businessName}`,
    `Business type: ${request.businessType}`,
    `Output language: ${request.language}`,
    '',
    'Description:',
    request.description,
  ];

  if (request.details !== undefined) {
    const entries = Object.entries(request.details);
    if (entries.length > 0) {
      lines.push('', 'Additional details:');
      for (const [key, value] of entries) {
        lines.push(`- ${key}: ${value}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Appends a prior schema-validation failure to the prompt for a single retry,
 * asking the model to correct the specific problem.
 */
export function withValidationFeedback(prompt: string, validationError: string): string {
  return [
    prompt,
    '',
    'Your previous response failed schema validation with this error:',
    validationError,
    'Return a corrected spec that resolves the error and still matches the schema exactly.',
  ].join('\n');
}
