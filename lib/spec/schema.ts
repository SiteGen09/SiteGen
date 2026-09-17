import { z } from 'zod';

/**
 * Rejects any string carrying angle brackets. Generated copy is rendered into
 * HTML, so `<` / `>` never belong in a validated spec even after escaping.
 */
const HTML_CHARS = /[<>]/;

/** Stable machine identifiers for pages and sections. */
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Route segment for a generated page. */
const SLUG_PATTERN = /^[a-z0-9-]{1,60}$/;

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** BCP-47-ish: primary subtag plus optional script/region/variant subtags. */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Root-relative path, in-page fragment, or absolute https URL. */
const SAFE_HREF_PATTERN = /^(\/|#|https:\/\/)/;

/** Whitespace and quoting characters that enable attribute/URL escapes. */
const UNSAFE_HREF_CHARS = /[\s<>"'`\\]/;

/**
 * Every human-readable string in a spec goes through this pipeline: trimmed,
 * non-empty, length-capped, and free of HTML markup characters.
 */
export function safeText(max: number) {
  return z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .max(max, `must be at most ${max} characters`)
    .refine((value) => !HTML_CHARS.test(value), {
      message: 'must not contain HTML characters',
    });
}

const identifier = z.string().regex(ID_PATTERN, 'must be kebab-case, 1-40 characters');

/**
 * Links are restricted to same-site paths, fragments, and https URLs, which
 * makes `javascript:` (and every other scheme) unrepresentable.
 */
const href = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200, 'must be at most 200 characters')
  .regex(SAFE_HREF_PATTERN, 'must start with "/", "#", or "https://"')
  .refine((value) => !UNSAFE_HREF_CHARS.test(value), {
    message: 'must not contain whitespace or quoting characters',
  });

export const FONT_PAIRINGS = [
  'inter-inter',
  'playfair-inter',
  'dm-serif-dm-sans',
  'space-grotesk-ibm-plex-sans',
  'lora-source-sans',
  'poppins-work-sans',
] as const;

export const TONES = ['professional', 'friendly', 'bold', 'minimal', 'playful'] as const;

const metaSchema = z.object({
  businessName: safeText(120),
  tagline: safeText(160),
  language: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .regex(LANGUAGE_PATTERN, 'must be a BCP-47 language tag'),
  businessType: safeText(60),
});

const themeSchema = z.object({
  primaryColor: z.string().regex(HEX_COLOR_PATTERN, 'must be a 6-digit hex color'),
  accentColor: z.string().regex(HEX_COLOR_PATTERN, 'must be a 6-digit hex color'),
  fontPairing: z.enum(FONT_PAIRINGS),
  tone: z.enum(TONES),
});

const heroSectionSchema = z.object({
  id: identifier,
  type: z.literal('hero'),
  headline: safeText(120),
  subheadline: safeText(200),
  ctaLabel: safeText(40),
  ctaHref: href,
});

const featuresSectionSchema = z.object({
  id: identifier,
  type: z.literal('features'),
  heading: safeText(80),
  items: z
    .array(
      z.object({
        title: safeText(60),
        description: safeText(200),
      }),
    )
    .min(1)
    .max(8),
});

const aboutSectionSchema = z.object({
  id: identifier,
  type: z.literal('about'),
  heading: safeText(80),
  body: safeText(1500),
});

const testimonialsSectionSchema = z.object({
  id: identifier,
  type: z.literal('testimonials'),
  heading: safeText(80),
  items: z
    .array(
      z.object({
        quote: safeText(400),
        author: safeText(80),
        role: safeText(80).optional(),
      }),
    )
    .min(1)
    .max(6),
});

const pricingSectionSchema = z.object({
  id: identifier,
  type: z.literal('pricing'),
  heading: safeText(80),
  tiers: z
    .array(
      z.object({
        name: safeText(40),
        price: safeText(20),
        period: safeText(20).optional(),
        features: z.array(safeText(80)).min(1).max(10),
        ctaLabel: safeText(40),
      }),
    )
    .min(1)
    .max(4),
});

const faqSectionSchema = z.object({
  id: identifier,
  type: z.literal('faq'),
  heading: safeText(80),
  items: z
    .array(
      z.object({
        question: safeText(160),
        answer: safeText(600),
      }),
    )
    .min(1)
    .max(10),
});

const contactSectionSchema = z.object({
  id: identifier,
  type: z.literal('contact'),
  heading: safeText(80),
  email: z.email('must be a valid email address').max(254).optional(),
  phone: safeText(30).optional(),
  address: safeText(200).optional(),
});

const ctaSectionSchema = z.object({
  id: identifier,
  type: z.literal('cta'),
  headline: safeText(120),
  ctaLabel: safeText(40),
  ctaHref: href,
});

const gallerySectionSchema = z.object({
  id: identifier,
  type: z.literal('gallery'),
  heading: safeText(80).optional(),
  images: z
    .array(
      z.object({
        alt: safeText(120),
        /** Image-generation prompt, never a URL. */
        prompt: safeText(300),
      }),
    )
    .min(1)
    .max(12),
});

export const sectionSchema = z.discriminatedUnion('type', [
  heroSectionSchema,
  featuresSectionSchema,
  aboutSectionSchema,
  testimonialsSectionSchema,
  pricingSectionSchema,
  faqSectionSchema,
  contactSectionSchema,
  ctaSectionSchema,
  gallerySectionSchema,
]);

export const pageSchema = z.object({
  id: identifier,
  slug: z.string().regex(SLUG_PATTERN, 'must be kebab-case, 1-60 characters'),
  title: safeText(80),
  sections: z.array(sectionSchema).min(1).max(12),
});

export const siteSpecSchema = z.object({
  meta: metaSchema,
  theme: themeSchema,
  pages: z
    .array(pageSchema)
    .min(1)
    .max(8)
    .refine((pages) => new Set(pages.map((page) => page.slug)).size === pages.length, {
      message: 'page slugs must be unique',
    }),
});

export type SiteSpec = z.infer<typeof siteSpecSchema>;
export type SitePage = z.infer<typeof pageSchema>;
export type SiteSection = z.infer<typeof sectionSchema>;
export type SectionType = SiteSection['type'];
