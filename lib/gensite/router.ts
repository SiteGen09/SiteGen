import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import { totalMessageChars, totalToolChars } from '@/lib/chat/request';
import type { ReasoningEffort } from '@/lib/chat/reasoning';
import type { GensiteTier } from '@/lib/gensite/config';

/** How much thinking a request needs, as the router judges it. */
export type Difficulty = 'simple' | 'medium' | 'hard';

/**
 * What the router looks at. All of it is read from the request itself; only a
 * request these rules cannot place is sent to the difficulty classifier.
 */
export interface RouteFeatures {
  /** Prompt size in characters: messages, attachments and tool schemas. */
  inputChars: number;
  /** The client sent tools, which is what an agent turn (Claude Code, Codex) looks like. */
  hasTools: boolean;
  hasImages: boolean;
  reasoning: ReasoningEffort | undefined;
  /** Length of the newest user message. */
  lastUserChars: number;
  /** The newest user message reads like a programming request. */
  codeSignals: boolean;
  /** The rules' reading of the newest user message; null when they cannot tell. */
  difficulty: Difficulty | null;
}

/** About 150k tokens: past this, a million-token window is worth more than anything else. */
export const LONG_CONTEXT_CHARS = 600_000;

/**
 * Programming vocabulary. Words that are also ordinary English ("return",
 * "class", "import", "node") are left out: a finance question about returns is
 * not a coding task.
 */
const CODE_SIGNALS =
  /```|\b(?:function|def|const|async|await|stack ?trace|traceback|exception|compile|compiler|refactor|debug|bug|regex|sql|api|endpoint|typescript|javascript|python|rust|golang|java|kotlin|swift|react|next\.js|node\.js|npm|pnpm|docker|kubernetes|git|github|repo|codebase|null pointer|segfault)\b|[{};]\s*$/im;

/** Words that only come up when a task needs real thought. Each is worth 3. */
const STRONG_HARD =
  /\b(?:prove|proof|proofs|derive|derivation|theorem|lemma|rigorous(?:ly)?|system design|architect(?:ure|ing)?|threat model(?:ing)?|root cause|formal(?:ly)? verif\w*|np-hard|asymptotic|big-?o)\b/gi;

/** Words that often mean a demanding task. Each is worth 2. */
const HARD =
  /\b(?:design|trade-?offs?|distributed|scalab\w*|concurren\w*|algorithm\w*|strateg\w*|analy[sz]\w*|evaluat\w*|critique|in[- ]depth|comprehensive|step[- ]by[- ]step|roadmap|migrat\w*|edge cases?|optimi[sz]\w*|pros and cons|business plan|financial model|diagnos\w*|research|hypothes\w*|calculate|probability|statistic\w*|integral|derivative|equation)\b/gi;

/** Mathematical notation: LaTeX commands, math symbols, or an exponent. */
const MATH = /\\(?:frac|sum|int|sqrt|lim|prod|mathbb)|[∑∫√∀∃≤≥≠∞∂∇π]|\b\w+\s*\^\s*\w+/;

/** Things any model does well and fast. */
const SIMPLE =
  /^\s*(?:hi|hello|hey|yo|thanks|thank you|thx|ok(?:ay)?|cool|nice|great|good (?:morning|afternoon|evening|night)|bye)\b[\s!.?,]*$|\b(?:translate|rephrase|reword|paraphrase|fix (?:the |my )?(?:grammar|spelling|typos?)|proofread|spell ?check|tl;?dr|summari[sz]e (?:this|it|the following)|what(?:'s| is) the capital|what time|what day|how do you spell|synonyms? (?:of|for)|convert \d)/i;

/** Below this, a message with no sign of difficulty is small talk or a quick fact. */
const TINY_MESSAGE_CHARS = 60;
/** Above this, a message is a substantial brief whatever its words. */
const LONG_MESSAGE_CHARS = 1_500;

function matches(pattern: RegExp, text: string): number {
  return text.match(pattern)?.length ?? 0;
}

/**
 * Scores the newest user message. Positive means hard, negative simple.
 * Exported for tests; {@link assessDifficulty} turns it into a decision.
 */
export function difficultyScore(text: string): number {
  let score = 0;
  score += 3 * Math.min(matches(STRONG_HARD, text), 2);
  score += 2 * Math.min(matches(HARD, text), 3);
  if (MATH.test(text)) score += 2;
  if ((text.match(/\?/g)?.length ?? 0) >= 3) score += 1;
  if ((text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm)?.length ?? 0) >= 3) score += 1;
  if (text.length > LONG_MESSAGE_CHARS) score += 1;
  if (text.length > 4 * LONG_MESSAGE_CHARS) score += 2;
  if (SIMPLE.test(text)) score -= 3;
  return score;
}

/**
 * The rules' verdict on a message, or null when they cannot tell and the
 * classifier should decide. The rules only commit when the signal is clear;
 * a wrong "simple" costs the user the most, so it needs the strongest case.
 */
export function assessDifficulty(text: string): Difficulty | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const score = difficultyScore(trimmed);
  if (score >= 3) return 'hard';
  if (score <= -2) return 'simple';
  if (score <= 0 && trimmed.length <= TINY_MESSAGE_CHARS) return 'simple';
  return null;
}

/**
 * Message text, whatever shape it arrived in. The dashboard sends content as
 * a part array (text plus files); the APIs send a string.
 */
function messageText(message: ChatMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
      ? String((part as { text?: unknown }).text ?? '')
      : ''))
    .join('');
}

function hasImagePart(message: ChatMessage): boolean {
  const content = message.content as unknown;
  return Array.isArray(content) && content.some((part) => {
    if (typeof part !== 'object' || part === null) return false;
    const { type, mediaType } = part as { type?: unknown; mediaType?: unknown };
    return type === 'image' || (type === 'file' && typeof mediaType === 'string' && mediaType.startsWith('image/'));
  });
}

/** The newest user message's text. */
export function latestUserText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') return messageText(message);
  }
  return '';
}

export function extractFeatures(input: {
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[] | undefined;
  reasoning?: ReasoningEffort | undefined;
}): RouteFeatures {
  const last = latestUserText(input.messages);
  return {
    inputChars: totalMessageChars(input.messages) + totalToolChars(input.tools),
    hasTools: (input.tools?.length ?? 0) > 0,
    hasImages: input.messages.some((message) =>
      (message.attachments ?? []).some((attachment) => attachment.mediaType.startsWith('image/')) || hasImagePart(message)),
    reasoning: input.reasoning,
    lastUserChars: last.length,
    codeSignals: CODE_SIGNALS.test(last),
    difficulty: assessDifficulty(last),
  };
}

/** The tier each difficulty is served on. Hard goes straight to the strongest models. */
export const DIFFICULTY_TIER: Record<Difficulty, GensiteTier> = { simple: 'fast', medium: 'balanced', hard: 'max' };

/** Where a request goes, and whether the classifier should be asked first. */
export interface RouteDecision {
  tier: GensiteTier;
  /**
   * The rules could not tell how hard the request is. `tier` is then the
   * choice to use if the classifier cannot answer in time: the stronger
   * option, since a weak answer costs more than a slightly slower one.
   */
  classify: boolean;
}

/**
 * Picks the tier for one request. Order matters: each rule only sees requests
 * the ones above it let through.
 *
 * 1. A prompt too big for most windows goes where it fits.
 * 2. An explicit request for the most effort gets the strongest model.
 * 3. Agent turns and anything asking for real effort go to the best coders:
 *    that is where a weaker model costs the user the most.
 * 4. Pictures without an agent loop go to a vision model.
 * 5. Low effort goes fast.
 * 6. Programming questions without tools still go to the coders.
 * 7. Otherwise the message's difficulty decides; when the rules cannot tell,
 *    the classifier does.
 */
export function decideRoute(features: RouteFeatures): RouteDecision {
  const fixed = (tier: GensiteTier): RouteDecision => ({ tier, classify: false });
  if (features.inputChars > LONG_CONTEXT_CHARS) return fixed('long');
  if (features.reasoning === 'xhigh') return fixed('max');
  if (features.hasTools || features.reasoning === 'high') return fixed('coder');
  if (features.hasImages) return fixed(features.difficulty === 'hard' ? 'max' : 'vision');
  if (features.reasoning === 'none' || features.reasoning === 'minimal' || features.reasoning === 'low') return fixed('fast');
  if (features.codeSignals) return fixed(features.difficulty === 'hard' ? 'max' : 'coder');
  if (features.difficulty !== null) return fixed(DIFFICULTY_TIER[features.difficulty]);
  return { tier: 'balanced', classify: true };
}

/** The tier the rules alone would pick. */
export function chooseTier(features: RouteFeatures): GensiteTier {
  return decideRoute(features).tier;
}

/**
 * Tiers to fall back through when none of a tier's models can serve, closest
 * substitute first. A request is better answered by a sibling tier than
 * refused outright.
 */
export const TIER_FALLBACKS: Record<GensiteTier, readonly GensiteTier[]> = {
  fast: ['balanced', 'coder'],
  balanced: ['coder', 'fast'],
  coder: ['max', 'balanced'],
  max: ['coder', 'balanced'],
  vision: ['balanced', 'coder'],
  long: ['coder', 'balanced'],
};
