/**
 * Discriminated provider usage — missing must never silently bill as free.
 */

/**
 * How cache token fields relate to prompt/input tokens for billing.
 *
 * - `subset` (OpenAI): `promptTokens` includes cached tokens; bill uncached at
 *   input rate + cached at cache tiers.
 * - `additive` (Anthropic): `promptTokens` is uncached/base input only; cache
 *   read/write are charged in addition (total input = input + cache fields).
 *
 * Must be set by adapters and frozen into outbox context — never inferred from
 * relative token amounts.
 */
export type CacheAccountingMode = "subset" | "additive";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  /**
   * Explicit cache billing mode from the adapter. Required for correct charges
   * when cache counters are present; frozen into settlement outbox context.
   */
  cacheAccounting?: CacheAccountingMode;
};

export type ProviderUsage =
  | { status: "reported"; usage: TokenUsage }
  | { status: "missing"; reason: string; providerRequestId?: string };

/**
 * Partial Anthropic stream usage fragment. Missing sides stay undefined —
 * never coerced to zero (that would undercharge when only one side arrives).
 */
export type AnthropicStreamUsageFragment = {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/**
 * Accumulator for Anthropic stream usage merges. Tracks which sides were
 * actually reported so settlement can require a complete picture.
 */
export type AnthropicStreamUsageAccum = TokenUsage & {
  hasInput: boolean;
  hasOutput: boolean;
  /** True when part sum overflowed MAX_SAFE_INTEGER — never settle. */
  overflow?: boolean;
};

/**
 * Parse a non-negative **safe integer** token field.
 * Returns undefined when absent; null when present but malformed (fractional,
 * negative, non-number, or outside Number.MAX_SAFE_INTEGER) so callers refuse
 * free settlement instead of coercing / poisoning counters with Infinity.
 */
function numField(v: unknown): number | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    return v;
  }
  // Present but invalid (fraction, string, negative, NaN, unsafe int, object).
  return null;
}

/** Safe non-negative integer add; null on overflow or unsafe inputs. */
function safeAddNonNeg(...vals: number[]): number | null {
  let sum = 0;
  for (const v of vals) {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    const next = sum + v;
    if (!Number.isSafeInteger(next)) return null;
    sum = next;
  }
  return sum;
}

function firstNum(...vals: unknown[]): number | undefined | null {
  let sawMalformed = false;
  for (const v of vals) {
    if (v === undefined) continue;
    const n = numField(v);
    if (n === null) {
      sawMalformed = true;
      continue;
    }
    if (n !== undefined) return n;
  }
  return sawMalformed ? null : undefined;
}

/**
 * Sum of token parts that count toward processed total (analytics + rate limits).
 *
 * - **subset** (OpenAI): `promptTokens` already includes cached tokens →
 *   prompt + completion.
 * - **additive** (Anthropic): total input = input + cache_read + cache_write →
 *   prompt + completion + cacheRead + cacheWrite.
 *
 * Reasoning is **never** added: it is included inside completion/output.
 *
 * Returns `null` when any part is unsafe or the sum overflows MAX_SAFE_INTEGER
 * (fail-closed — callers must not settle / meter with a poisoned total).
 */
export function partsSumForProcessedTotal(params: {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheAccounting?: CacheAccountingMode;
}): number | null {
  const prompt = params.promptTokens;
  const completion = params.completionTokens;
  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheWriteTokens ?? 0;
  if (params.cacheAccounting === "additive") {
    // Anthropic: total_input = input_tokens + cache_read + cache_write
    return safeAddNonNeg(prompt, completion, cacheRead, cacheWrite);
  }
  // OpenAI subset: cached is inside promptTokens.
  return safeAddNonNeg(prompt, completion);
}

/**
 * Normalize processed total for analytics and token-window rate limits.
 * Never undercounts additive cache; never double-counts reasoning.
 *
 * Prefer a positive provider total when it is at least the parts sum;
 * otherwise use the mode-correct parts sum.
 *
 * Returns `null` on unsafe integers or arithmetic overflow (fail-closed).
 */
export function normalizeProcessedTotalTokens(usage: {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cacheAccounting?: CacheAccountingMode;
}): number | null {
  const parts = partsSumForProcessedTotal(usage);
  if (parts === null) return null;
  const reported = usage.totalTokens;
  if (reported !== undefined) {
    if (!Number.isSafeInteger(reported) || reported < 0) return null;
    if (reported > 0) {
      // Never undercount (Anthropic provider total omits additive cache fields).
      const max = Math.max(reported, parts);
      return Number.isSafeInteger(max) ? max : null;
    }
  }
  return parts;
}

/**
 * OpenAI-only: reject provider totals that are strictly below prompt+completion
 * (cannot under-count limits). Zero with nonzero parts falls through to parts.
 * Overflow / unsafe sum → "overflow" (fail-closed).
 */
function resolveOpenAIProviderTotal(
  prompt: number,
  completion: number,
  totalTokens: number | undefined,
): number | "inconsistent" | "overflow" {
  const sum = safeAddNonNeg(prompt, completion);
  if (sum === null) return "overflow";
  if (totalTokens === undefined) return sum;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return "overflow";
  if (totalTokens === 0 && sum > 0) return sum;
  if (totalTokens < sum) return "inconsistent";
  return totalTokens;
}

/**
 * OpenAI-style usage object → ProviderUsage.
 * Requires both prompt_tokens and completion_tokens as integers (incomplete
 * objects like {total_tokens:100} are missing, not free zero-charge reported).
 */
export function parseOpenAIProviderUsage(u: unknown): ProviderUsage {
  if (!u || typeof u !== "object") {
    return { status: "missing", reason: "usage_absent" };
  }
  const o = u as Record<string, unknown>;
  const hasAny =
    "prompt_tokens" in o ||
    "completion_tokens" in o ||
    "total_tokens" in o;
  if (!hasAny) {
    return { status: "missing", reason: "usage_empty_object" };
  }

  // Both prompt and completion must be present for an authoritative report.
  if (!("prompt_tokens" in o) || !("completion_tokens" in o)) {
    return { status: "missing", reason: "usage_incomplete" };
  }

  const promptTokens = numField(o.prompt_tokens);
  const completionTokens = numField(o.completion_tokens);
  const totalTokens = numField(o.total_tokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }
  // Keys are required present; values must be integers (not undefined).
  if (promptTokens === undefined || completionTokens === undefined) {
    return { status: "missing", reason: "usage_incomplete" };
  }

  // reasoning_tokens may live top-level or under completion_tokens_details.
  const completionDetails =
    typeof o.completion_tokens_details === "object" &&
    o.completion_tokens_details !== null
      ? (o.completion_tokens_details as Record<string, unknown>)
      : undefined;
  const reasoningTokens = firstNum(
    o.reasoning_tokens,
    completionDetails?.reasoning_tokens,
  );
  if (reasoningTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }

  const promptTokensDetails =
    typeof o.prompt_tokens_details === "object" && o.prompt_tokens_details !== null
      ? (o.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cacheReadTokens = firstNum(
    promptTokensDetails?.cached_tokens,
    o.cache_read_tokens,
  );
  const cacheWriteTokens = firstNum(
    o.cache_creation_tokens,
    o.cache_write_tokens,
  );
  if (cacheReadTokens === null || cacheWriteTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }

  const providerTotal = resolveOpenAIProviderTotal(
    promptTokens,
    completionTokens,
    totalTokens,
  );
  if (providerTotal === "inconsistent") {
    return { status: "missing", reason: "usage_inconsistent_total" };
  }
  if (providerTotal === "overflow") {
    return { status: "missing", reason: "usage_overflow" };
  }

  const usageBase = {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens ?? undefined,
    cacheReadTokens: cacheReadTokens ?? undefined,
    cacheWriteTokens: cacheWriteTokens ?? undefined,
    // OpenAI prompt_tokens includes cached tokens.
    cacheAccounting: "subset" as const,
  };
  const normalizedTotal = normalizeProcessedTotalTokens({
    ...usageBase,
    totalTokens: providerTotal,
  });
  if (normalizedTotal === null) {
    return { status: "missing", reason: "usage_overflow" };
  }
  return {
    status: "reported",
    usage: {
      ...usageBase,
      totalTokens: normalizedTotal,
    },
  };
}

/**
 * Anthropic-style usage object → ProviderUsage.
 * Requires both input_tokens and output_tokens (incomplete objects missing).
 */
export function parseAnthropicProviderUsage(u: unknown): ProviderUsage {
  if (!u || typeof u !== "object") {
    return { status: "missing", reason: "usage_absent" };
  }
  const o = u as Record<string, unknown>;
  const hasAny = "input_tokens" in o || "output_tokens" in o;
  if (!hasAny) {
    return { status: "missing", reason: "usage_empty_object" };
  }

  if (!("input_tokens" in o) || !("output_tokens" in o)) {
    return { status: "missing", reason: "usage_incomplete" };
  }

  const promptTokens = numField(o.input_tokens);
  const completionTokens = numField(o.output_tokens);
  if (promptTokens === null || completionTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }
  if (promptTokens === undefined || completionTokens === undefined) {
    return { status: "missing", reason: "usage_incomplete" };
  }

  const reasoningTokens = numField(o.reasoning_tokens);
  if (reasoningTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }

  const cacheReadTokens = firstNum(
    o.cache_read_input_tokens,
    o.cache_read_tokens,
  );
  const cacheWriteTokens = firstNum(
    o.cache_creation_input_tokens,
    o.cache_creation_tokens,
  );
  if (cacheReadTokens === null || cacheWriteTokens === null) {
    return { status: "missing", reason: "usage_malformed" };
  }

  const usageBase = {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens ?? undefined,
    cacheReadTokens: cacheReadTokens ?? undefined,
    cacheWriteTokens: cacheWriteTokens ?? undefined,
    // Anthropic: input_tokens is base/uncached; cache fields are additive.
    cacheAccounting: "additive" as const,
  };
  const normalizedTotal = normalizeProcessedTotalTokens(usageBase);
  if (normalizedTotal === null) {
    return { status: "missing", reason: "usage_overflow" };
  }
  return {
    status: "reported",
    usage: {
      ...usageBase,
      // total_input = input + cache_read + cache_write; + output; no reasoning addend.
      totalTokens: normalizedTotal,
    },
  };
}

/**
 * Anthropic stream fragments often send input on message_start and output on
 * message_delta. Parse only **present** sides — never coerce missing to zero.
 * Malformed present fields fail closed (null → skip fragment).
 */
export function parseAnthropicStreamUsageFragment(
  u: unknown,
): AnthropicStreamUsageFragment | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  if (!("input_tokens" in o) && !("output_tokens" in o)) return null;

  const promptTokens = "input_tokens" in o ? numField(o.input_tokens) : undefined;
  const completionTokens =
    "output_tokens" in o ? numField(o.output_tokens) : undefined;
  // Key present but malformed → discard whole fragment.
  if (promptTokens === null || completionTokens === null) return null;

  const reasoningTokens =
    "reasoning_tokens" in o ? numField(o.reasoning_tokens) : undefined;
  if (reasoningTokens === null) return null;

  const cacheReadTokens = firstNum(
    o.cache_read_input_tokens,
    o.cache_read_tokens,
  );
  const cacheWriteTokens = firstNum(
    o.cache_creation_input_tokens,
    o.cache_creation_tokens,
  );
  if (cacheReadTokens === null || cacheWriteTokens === null) return null;

  const frag: AnthropicStreamUsageFragment = {};
  if (promptTokens !== undefined) frag.promptTokens = promptTokens;
  if (completionTokens !== undefined) frag.completionTokens = completionTokens;
  if (reasoningTokens !== undefined) frag.reasoningTokens = reasoningTokens;
  if (cacheReadTokens !== undefined) frag.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) frag.cacheWriteTokens = cacheWriteTokens;
  // Must carry at least one side.
  if (frag.promptTokens === undefined && frag.completionTokens === undefined) {
    return null;
  }
  return frag;
}

/**
 * Merge Anthropic stream fragments. Takes max of each side; tracks presence so
 * settlement can require both input and output before treating usage as
 * authoritative (avoids undercharging on input-only or output-only terminals).
 */
export function mergeAnthropicStreamUsage(
  prev: AnthropicStreamUsageAccum | undefined,
  next: AnthropicStreamUsageFragment,
): AnthropicStreamUsageAccum {
  const hasInput =
    (prev?.hasInput ?? false) || next.promptTokens !== undefined;
  const hasOutput =
    (prev?.hasOutput ?? false) || next.completionTokens !== undefined;
  const promptTokens =
    next.promptTokens !== undefined
      ? Math.max(prev?.promptTokens ?? 0, next.promptTokens)
      : (prev?.promptTokens ?? 0);
  const completionTokens =
    next.completionTokens !== undefined
      ? Math.max(prev?.completionTokens ?? 0, next.completionTokens)
      : (prev?.completionTokens ?? 0);
  const reasoningTokens = Math.max(
    prev?.reasoningTokens ?? 0,
    next.reasoningTokens ?? 0,
  );
  const cacheReadTokens = Math.max(
    prev?.cacheReadTokens ?? 0,
    next.cacheReadTokens ?? 0,
  );
  const cacheWriteTokens = Math.max(
    prev?.cacheWriteTokens ?? 0,
    next.cacheWriteTokens ?? 0,
  );
  const partial = {
    promptTokens,
    completionTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
    cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
    cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
    cacheAccounting: "additive" as const,
  };
  // Overflow → zero total; isAnthropicStreamUsageComplete still true only with
  // both sides, but toTokenUsage / settlement must re-check safe totals.
  const total = normalizeProcessedTotalTokens(partial);
  return {
    ...partial,
    totalTokens: total ?? 0,
    hasInput,
    hasOutput,
    overflow: total === null,
  };
}

/** Both stream sides reported — safe to treat as authoritative TokenUsage. */
export function isAnthropicStreamUsageComplete(
  u: AnthropicStreamUsageAccum | undefined,
): u is AnthropicStreamUsageAccum {
  return !!u && u.hasInput && u.hasOutput && !u.overflow;
}

/** Strip presence flags for settlement / ChatResponse usage. */
export function toTokenUsage(u: AnthropicStreamUsageAccum): TokenUsage {
  if (u.overflow) {
    // Callers should check isAnthropicStreamUsageComplete first; never invent
    // a billable total from an overflowed accumulator.
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheAccounting: u.cacheAccounting ?? "additive",
    };
  }
  const usage: TokenUsage = {
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    reasoningTokens: u.reasoningTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    cacheAccounting: u.cacheAccounting ?? "additive",
    totalTokens: 0,
  };
  const total = normalizeProcessedTotalTokens(usage);
  usage.totalTokens = total ?? 0;
  return usage;
}

/** Zero usage placeholder only for error/incomplete paths that never settle. */
export const ZERO_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};
