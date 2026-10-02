import { generateText } from 'ai';

import type { ChannelRow } from '@/lib/ai/fallback';
import { buildAI, type ProviderCreds } from '@/lib/ai/provider';
import type { Difficulty } from '@/lib/gensite/router';

/**
 * The second opinion for requests the routing rules cannot place.
 *
 * A fast model reads the newest user message and answers with one word. It is
 * only asked when the rules are unsure, never for agent turns (those always go
 * to the strongest coders), and it has a hard time limit: a verdict that
 * arrives late is worth less than the delay, so the router falls back to its
 * safe default instead.
 */
export const CLASSIFY_TIMEOUT_MS = 2_500;

/** Enough of the message to judge it; the rest only adds latency. */
const MAX_CLASSIFIED_CHARS = 2_000;

const INSTRUCTIONS = [
  'You rate how difficult a user request is for an AI assistant. Reply with exactly one word.',
  'SIMPLE: greetings, small talk, one-line facts, definitions, rewording, short translations, quick everyday questions.',
  'MEDIUM: ordinary questions, explanations of a topic, advice, emails, short essays and other everyday writing.',
  'HARD: multi-step reasoning, maths or proofs, puzzles, system or architecture design, strategy, deep analysis, planning, research-style questions, anything that needs careful expert thought.',
  'If unsure between two levels, pick the harder one.',
].join('\n');

/** The verdict in a reply, if it has one. */
export function parseDifficulty(reply: string): Difficulty | null {
  const match = /\b(SIMPLE|MEDIUM|HARD)\b/i.exec(reply);
  return match ? (match[1]!.toLowerCase() as Difficulty) : null;
}

export interface ClassifyResult {
  difficulty: Difficulty | null;
  latencyMs: number;
  /** Why no verdict came back, for the log. */
  failure?: string;
}

/**
 * Asks `channel` how hard `text` is. Never throws: any failure, including the
 * time limit, comes back as a null difficulty.
 */
export async function classifyDifficulty(input: {
  text: string;
  channel: ChannelRow;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
  timeoutMs?: number;
}): Promise<ClassifyResult> {
  const startedAt = Date.now();
  try {
    const creds = await input.buildCreds(input.channel);
    const result = await generateText({
      model: buildAI(creds).languageModel(input.channel.modelId),
      maxRetries: 0,
      system: INSTRUCTIONS,
      prompt: input.text.slice(0, MAX_CLASSIFIED_CHARS),
      // Room for a thinking model's preamble; the verdict itself is one word.
      maxOutputTokens: 64,
      temperature: 0,
      // A one-word verdict needs no deliberation, and thinking is most of a small model's latency.
      reasoning: 'none',
      abortSignal: AbortSignal.timeout(input.timeoutMs ?? CLASSIFY_TIMEOUT_MS),
    });
    const difficulty = parseDifficulty(result.text);
    return {
      difficulty,
      latencyMs: Date.now() - startedAt,
      ...(difficulty === null ? { failure: 'unparsed reply' } : {}),
    };
  } catch (err) {
    return {
      difficulty: null,
      latencyMs: Date.now() - startedAt,
      failure: err instanceof Error ? err.name : 'error',
    };
  }
}
