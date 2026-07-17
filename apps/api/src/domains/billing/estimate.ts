/**
 * Pure billing estimation (task 9.1).
 * Conservative pre-flight math only — no I/O.
 */

import type { ModelDoc } from "@tokenpanel/db";
import type { ChatMessage } from "../../providers/types.ts";
import {
  CHARS_PER_TOKEN_ESTIMATE_COUNT,
  DEFAULT_COMPLETION_CAP,
  NON_TEXT_PART_TOKENS_COUNT,
  TOKENS_PER_MILLION_COUNT,
} from "./policy.ts";

/**
 * Conservative prompt-token estimate from message array.
 * Text → ~chars/token; each non-text part → fixed overhead.
 * Over-estimate is safe for pre-flight.
 */
export function estimatePromptTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  let nonTextParts = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "text") {
          chars += part.text?.length ?? 0;
        } else {
          nonTextParts += 1;
        }
      }
    }
  }
  return Math.max(
    1,
    Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE_COUNT) +
      nonTextParts * NON_TEXT_PART_TOKENS_COUNT,
  );
}

/**
 * Worst-case input + output price across ACTIVE entries.
 * Settlement uses entry.price ?? model.price; pre-flight must reserve against
 * the most expensive active entry.
 */
export function worstCaseActiveEntryPrice(model: ModelDoc): {
  inputMinorPerMillion: number;
  outputMinorPerMillion: number;
} {
  const active = model.entries.filter((e) => e.active);
  let maxIn = model.price.inputMinorPerMillion;
  let maxOut = model.price.outputMinorPerMillion;
  for (const e of active) {
    const s = e.price ?? model.price;
    if (s.inputMinorPerMillion > maxIn) maxIn = s.inputMinorPerMillion;
    if (s.outputMinorPerMillion > maxOut) maxOut = s.outputMinorPerMillion;
  }
  return { inputMinorPerMillion: maxIn, outputMinorPerMillion: maxOut };
}

/**
 * Completion token cap for pre-flight.
 * Preference: request max_tokens > model.limits.output > DEFAULT_COMPLETION_CAP.
 * Explicit 0 means no completion expected.
 */
export function resolveCompletionCap(
  maxCompletionTokens: number | undefined,
  model: ModelDoc,
): number {
  if (maxCompletionTokens !== undefined) return Math.max(0, maxCompletionTokens);
  return Math.max(0, model.limits.output ?? DEFAULT_COMPLETION_CAP);
}

/** Conservative pre-flight spend estimate in minor units. */
export function estimatePreFlightSpend(params: {
  readonly model: ModelDoc;
  readonly estimatedPromptTokens: number;
  readonly maxCompletionTokens?: number | undefined;
}): {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimatedTokens: number;
  readonly estimatedSpendMinor: number;
  readonly currency: string;
  readonly price: {
    readonly inputMinorPerMillion: number;
    readonly outputMinorPerMillion: number;
  };
} {
  const prompt = Math.max(0, params.estimatedPromptTokens);
  const completion = resolveCompletionCap(params.maxCompletionTokens, params.model);
  const price = worstCaseActiveEntryPrice(params.model);
  const estimatedSpendMinor =
    Math.ceil((prompt * price.inputMinorPerMillion) / TOKENS_PER_MILLION_COUNT) +
    Math.ceil(
      (completion * price.outputMinorPerMillion) / TOKENS_PER_MILLION_COUNT,
    );
  return {
    promptTokens: prompt,
    completionTokens: completion,
    estimatedTokens: prompt + completion,
    estimatedSpendMinor,
    currency: params.model.currency,
    price,
  };
}
