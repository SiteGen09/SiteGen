import { describe, expect, it } from 'vitest';
import portfolio from '@/fixtures/specs/portfolio.json';
import restaurant from '@/fixtures/specs/restaurant.json';
import saas from '@/fixtures/specs/saas.json';
import { siteSpecSchema } from '@/lib/spec/schema';

const META = {
  businessName: 'Northwind Bakery',
  tagline: 'Sourdough baked before sunrise',
  language: 'en-US',
  businessType: 'Neighbourhood bakery',
};

const THEME = {
  primaryColor: '#2F4858',
  accentColor: '#F6AE2D',
  fontPairing: 'lora-source-sans',
  tone: 'friendly',
};

const HERO = {
  id: 'home-hero',
  type: 'hero',
  headline: 'Bread worth the early alarm',
  subheadline: 'Naturally leavened loaves, laminated pastry, and coffee from a roaster four streets away.',
  ctaLabel: 'See today mix',
  ctaHref: '/menu',
};

/** A minimal valid spec whose single hero section can be patched per case. */
function specWithHero(overrides: Record<string, unknown> = {}): unknown {
  return {
    meta: META,
    theme: THEME,
    pages: [
      {
        id: 'home',
        slug: 'home',
        title: 'Northwind Bakery',
        sections: [{ ...HERO, ...overrides }],
      },
    ],
  };
}

function issuePaths(spec: unknown): string[] {
  const result = siteSpecSchema.safeParse(spec);
  expect(result.success).toBe(false);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('siteSpecSchema', () => {
  it('accepts the restaurant fixture', () => {
    const result = siteSpecSchema.safeParse(restaurant);
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('accepts the portfolio fixture', () => {
    const result = siteSpecSchema.safeParse(portfolio);
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('accepts the saas fixture', () => {
    const result = siteSpecSchema.safeParse(saas);
    expect(result.success, JSON.stringify(result.error?.issues, null, 2)).toBe(true);
  });

  it('accepts the minimal control spec used by the negative cases', () => {
    expect(siteSpecSchema.safeParse(specWithHero()).success).toBe(true);
  });

  it('rejects a headline containing a script tag', () => {
    expect(issuePaths(specWithHero({ headline: 'Bread <script>alert(1)</script>' }))).toContain(
      'pages.0.sections.0.headline',
    );
  });

  it('rejects HTML in nested section copy', () => {
    const spec = {
      meta: META,
      theme: THEME,
      pages: [
        {
          id: 'home',
          slug: 'home',
          title: 'Northwind Bakery',
          sections: [
            {
              id: 'home-features',
              type: 'features',
              heading: 'Why our bread',
              items: [{ title: 'Slow ferment', description: 'Rested <b>18 hours</b> before baking.' }],
            },
          ],
        },
      ],
    };
    expect(issuePaths(spec)).toContain('pages.0.sections.0.items.0.description');
  });

  it('rejects an unknown section type', () => {
    expect(issuePaths(specWithHero({ type: 'newsletter' }))).toContain('pages.0.sections.0.type');
  });

  it('rejects an over-length string', () => {
    expect(issuePaths(specWithHero({ headline: 'a'.repeat(121) }))).toContain(
      'pages.0.sections.0.headline',
    );
  });

  it('rejects a javascript: cta href', () => {
    expect(issuePaths(specWithHero({ ctaHref: 'javascript:alert(1)' }))).toContain(
      'pages.0.sections.0.ctaHref',
    );
  });

  it('rejects duplicate page slugs', () => {
    const page = {
      id: 'home',
      slug: 'home',
      title: 'Northwind Bakery',
      sections: [HERO],
    };
    expect(issuePaths({ meta: META, theme: THEME, pages: [page, { ...page, id: 'home-copy' }] })).toContain(
      'pages',
    );
  });
});
