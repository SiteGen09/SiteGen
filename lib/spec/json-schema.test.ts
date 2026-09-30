import { describe, expect, it } from 'vitest';

import { oneOfToAnyOf, siteSpecProviderSchema } from '@/lib/spec/json-schema';

/** Walks every node of a JSON value, yielding each object encountered. */
function* objects(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* objects(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  yield record;
  for (const value of Object.values(record)) yield* objects(value);
}

describe('oneOfToAnyOf', () => {
  it('renames oneOf at any depth', () => {
    expect(oneOfToAnyOf({ a: { b: [{ oneOf: [1, 2] }] } })).toEqual({
      a: { b: [{ anyOf: [1, 2] }] },
    });
  });

  it('leaves other keywords alone', () => {
    const input = { anyOf: [1], allOf: [2], properties: { oneOfThing: 3 } };
    expect(oneOfToAnyOf(input)).toEqual(input);
  });

  it('does not mutate its argument', () => {
    const input = { oneOf: [1] };
    oneOfToAnyOf(input);
    expect(input).toEqual({ oneOf: [1] });
  });

  it('passes through primitives and null', () => {
    expect(oneOfToAnyOf(null)).toBeNull();
    expect(oneOfToAnyOf('oneOf')).toBe('oneOf');
  });
});

describe('siteSpecProviderSchema', () => {
  const schema = siteSpecProviderSchema();

  it('contains no oneOf, which structured outputs reject', () => {
    for (const node of objects(schema)) {
      expect(node).not.toHaveProperty('oneOf');
    }
  });

  it('still expresses the section union as anyOf', () => {
    const unions = [...objects(schema)].filter((node) => Array.isArray(node.anyOf));
    expect(unions.length).toBeGreaterThan(0);
  });

  it('describes an object with pages', () => {
    expect(schema).toMatchObject({ type: 'object' });
    expect(JSON.stringify(schema)).toContain('pages');
  });
});
