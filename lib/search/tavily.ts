import { z } from 'zod';

/**
 * Web search for the gateway's server-side `web_search` tool, backed by
 * Tavily (https://docs.tavily.com). Tavily is built for agents: one call
 * returns ranked pages with a clean text extract, which is what a model needs
 * to answer from, rather than bare links it would have to fetch.
 */
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * What one `basic` search costs us: one Tavily credit at the pay-as-you-go
 * rate. Charged to the caller at the serving channel's markup, like tokens.
 */
export const TAVILY_USD_PER_SEARCH = 0.008;

const SEARCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
/** Enough of each page to answer from without flooding the context window. */
const SNIPPET_CHARS = 1_500;

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

export interface SearchOptions {
  allowedDomains?: readonly string[] | undefined;
  blockedDomains?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
}

export type SearchFn = (query: string, options?: SearchOptions) => Promise<SearchResult[]>;

const responseSchema = z.object({
  results: z.array(z.looseObject({
    title: z.string().catch(''),
    url: z.string(),
    content: z.string().catch(''),
    published_date: z.string().nullish(),
  })),
});

export function tavilyApiKey(): string | null {
  const key = process.env.TAVILY_API_KEY?.trim();
  return key ? key : null;
}

export function createTavilySearch(apiKey: string, fetchImpl: typeof fetch = fetch): SearchFn {
  return async (query, options) => {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)])
      : AbortSignal.timeout(SEARCH_TIMEOUT_MS);
    const response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: MAX_RESULTS,
        ...(options?.allowedDomains?.length ? { include_domains: options.allowedDomains } : {}),
        ...(options?.blockedDomains?.length ? { exclude_domains: options.blockedDomains } : {}),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`search provider HTTP ${response.status}`);
    const body = responseSchema.parse(await response.json());
    return body.results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content.slice(0, SNIPPET_CHARS),
      ...(result.published_date ? { publishedDate: result.published_date } : {}),
    }));
  };
}
