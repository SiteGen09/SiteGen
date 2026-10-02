import { jsonSchema, tool, type ToolSet } from 'ai';

import type { SearchFn, SearchResult } from '@/lib/search/tavily';

/**
 * Tools the gateway runs itself, inside the model's turn.
 *
 * Everything else a caller declares is theirs to run: the gateway stops at the
 * tool call and hands it back (see toToolSet). These are the exception. They
 * carry an `execute`, so the SDK runs them and feeds the result straight back
 * to the model, looping until it answers or calls one of the caller's tools.
 * The caller only ever sees the finished turn, plus whatever a wire format
 * chooses to show of the runs (Anthropic's `web_search_tool_result` blocks).
 */
export interface ServerToolKit {
  readonly tools: ToolSet;
  readonly names: ReadonlySet<string>;
  /** Most model steps one turn may take, the answering step included. */
  readonly maxSteps: number;
  /** What the tools could cost at most, in USD, for sizing the credit hold. */
  readonly reserveUsd: number;
  /** What the tools have cost so far, in USD. */
  costUsd(): number;
  /** Searches that returned results, for the usage record. */
  searchCount(): number;
  /** Refuses every further run, answering the model with `reason` instead. */
  disable(reason: string): void;
  /**
   * Per-step tool gating for the SDK: once the budget is spent the gateway's
   * tools are withdrawn so the model has to answer, and a caller's forced
   * choice of one of them applies to the first step only.
   */
  prepareStep(clientToolNames: readonly string[], forcedServerTool: boolean): (options: { stepNumber: number }) => {
    activeTools?: string[];
    toolChoice?: 'auto';
  } | undefined;
}

/** One run of a gateway tool, as recorded from a finished turn. */
export interface ServerToolRun {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
}

/** The web search tool's output, as the model and the wire formats see it. */
export type WebSearchOutput =
  | { results: Array<{ title: string; url: string; content: string; published?: string }>; note?: string }
  | { error: string };

/** Repeats of an earlier query this turn before the search tool is withdrawn. */
const MAX_REPEATED_SEARCHES = 2;

/** Queries that differ only in case, spacing or trailing punctuation are the same search. */
export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').replace(/[?.!,\s]+$/, '').trim();
}

export interface WebSearchKitOptions {
  search: SearchFn;
  /** The tool name the model sees; must not collide with a caller's tool. */
  name: string;
  maxSearches: number;
  usdPerSearch: number;
  allowedDomains?: readonly string[] | undefined;
  blockedDomains?: readonly string[] | undefined;
  /** For the tool description, so the model knows what "recent" means. */
  now?: Date;
}

function searchOutput(results: SearchResult[]): WebSearchOutput {
  return {
    results: results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
      ...(result.publishedDate ? { published: result.publishedDate } : {}),
    })),
  };
}

export function createWebSearchKit(options: WebSearchKitOptions): ServerToolKit {
  let searches = 0;
  let attempts = 0;
  let repeats = 0;
  let disabledReason: string | null = null;
  // One entry per distinct query: a repeat is answered from here, free, rather
  // than searched and billed again.
  const answered = new Map<string, Promise<WebSearchOutput>>();
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);

  const webSearch = tool({
    description:
      `Search the web for current information. Today is ${today}. Use it for anything that may have ` +
      'changed after your training data: news, releases, prices, documentation, error messages. ' +
      'Returns page titles, URLs and text extracts; cite the URLs you rely on. ' +
      `At most ${options.maxSearches} searches per answer, so make each query specific.`,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query }, { abortSignal }): Promise<WebSearchOutput> => {
      if (disabledReason !== null) return { error: disabledReason };
      if (typeof query !== 'string' || query.trim() === '') return { error: 'the query was empty' };
      const key = normalizeQuery(query);
      const earlier = answered.get(key);
      if (earlier !== undefined) {
        repeats += 1;
        const output = await earlier;
        return 'results' in output
          ? { ...output, note: 'You already ran this exact search; these are the same results. Use them, or search for something different.' }
          : output;
      }
      // Counted before the call so parallel calls in one step cannot overrun the budget.
      if (attempts >= options.maxSearches) return { error: 'search limit reached; answer with what you have' };
      attempts += 1;
      const pending = (async (): Promise<WebSearchOutput> => {
        try {
          const results = await options.search(query.trim(), {
            allowedDomains: options.allowedDomains,
            blockedDomains: options.blockedDomains,
            signal: abortSignal,
          });
          searches += 1;
          return searchOutput(results);
        } catch {
          // A failed search is not billed, and the model can still answer.
          return { error: 'the search failed; answer from what you know and say that you could not search' };
        }
      })();
      answered.set(key, pending);
      return pending;
    },
  });

  return {
    tools: { [options.name]: webSearch },
    names: new Set([options.name]),
    // Every search could take a step of its own, then one more to answer.
    maxSteps: options.maxSearches + 1,
    reserveUsd: options.maxSearches * options.usdPerSearch,
    costUsd: () => searches * options.usdPerSearch,
    searchCount: () => searches,
    disable(reason) {
      disabledReason = reason;
    },
    prepareStep(clientToolNames, forcedServerTool) {
      const maxSteps = this.maxSteps;
      return ({ stepNumber }) => {
        const spent = disabledReason !== null || attempts >= options.maxSearches || repeats >= MAX_REPEATED_SEARCHES ||
          stepNumber >= maxSteps - 1;
        if (!spent && !(forcedServerTool && stepNumber > 0)) return undefined;
        return {
          ...(spent ? { activeTools: [...clientToolNames] } : {}),
          ...(forcedServerTool && stepNumber > 0 ? { toolChoice: 'auto' as const } : {}),
        };
      };
    },
  };
}

/**
 * The gateway tool's name for a request: `web_search`, unless the caller
 * already has a tool by that name, which always wins.
 */
export function serverToolName(clientToolNames: readonly string[], preferred = 'web_search'): string {
  const taken = new Set(clientToolNames);
  if (!taken.has(preferred)) return preferred;
  let candidate = `gensite_${preferred}`;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `gensite_${preferred}_${suffix}`;
  return candidate;
}

/** A finished turn in order: the model's text, interleaved with the gateway tool runs between steps. */
export type TurnSegment = { type: 'text'; text: string } | { type: 'server-tool'; run: ServerToolRun };

interface StepLike {
  text: string;
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown; output: unknown }>;
}

export function turnSegments(steps: readonly StepLike[], names: ReadonlySet<string>): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const step of steps) {
    if (step.text !== '') segments.push({ type: 'text', text: step.text });
    for (const result of step.toolResults) {
      if (!names.has(result.toolName)) continue;
      segments.push({
        type: 'server-tool',
        run: { id: result.toolCallId, name: result.toolName, input: result.input, output: result.output },
      });
    }
  }
  return segments;
}

/**
 * The text of a whole multi-step turn, one paragraph per step. A wire format
 * that cannot show tool runs still gets everything the model said around them.
 */
export function segmentsText(segments: readonly TurnSegment[]): string {
  return segments
    .flatMap((segment) => (segment.type === 'text' && segment.text.trim() !== '' ? [segment.text.trim()] : []))
    .join('\n\n');
}

/** Whether the caller's tool choice names one of the gateway's tools. */
export function forcesServerTool(
  choice: { type: 'function'; function: { name: string } } | string | undefined,
  names: ReadonlySet<string>,
): boolean {
  return typeof choice === 'object' && names.has(choice.function.name);
}
