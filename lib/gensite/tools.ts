import { createWebSearchKit, serverToolName, type ServerToolKit } from '@/lib/chat/server-tools';
import { createTavilySearch, tavilyApiKey, TAVILY_USD_PER_SEARCH } from '@/lib/search/tavily';

/**
 * The gateway's web search tool for one request, or null when no search
 * backend is configured (no `TAVILY_API_KEY`), in which case requests simply
 * run without it.
 */
export function createGatewaySearchKit(options: {
  clientToolNames: readonly string[];
  maxSearches: number;
  /** A name the caller asked for (Anthropic's `web_search` server tool); otherwise one that avoids theirs. */
  name?: string | undefined;
  allowedDomains?: readonly string[] | undefined;
  blockedDomains?: readonly string[] | undefined;
}): ServerToolKit | null {
  const apiKey = tavilyApiKey();
  if (apiKey === null || options.maxSearches <= 0) return null;
  return createWebSearchKit({
    search: createTavilySearch(apiKey),
    name: options.name ?? serverToolName(options.clientToolNames),
    maxSearches: options.maxSearches,
    usdPerSearch: TAVILY_USD_PER_SEARCH,
    allowedDomains: options.allowedDomains,
    blockedDomains: options.blockedDomains,
  });
}
