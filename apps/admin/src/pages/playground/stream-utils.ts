/** Pure playground stream/event helpers (domain split). */
import { currencyExponent } from "../../utils/format.ts";

export type StreamPanelState = {
  content: string;
  reasoning: string;
  done: boolean;
  error: string | null;
  provider: {
    providerId: string;
    upstreamModelId: string;
    sdkType: string;
  } | null;
  cost: { costUnits: number; priceUnits: number; currency: string } | null;
  billed: boolean;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number | undefined;
  } | null;
};

export function applyEventToState(
  cur: StreamPanelState,
  evt: Record<string, unknown>,
): StreamPanelState {
  const obj = evt.object as string | undefined;
  if (obj === "playground.meta") return cur;
  if (obj === "playground.cost") {
    const cost = evt.cost as
      | { costUnits: number; priceUnits: number; currency: string }
      | undefined;
    const provider = evt.provider as StreamPanelState["provider"] | undefined;
    const billed = evt.billed as boolean | undefined;
    return {
      ...cur,
      cost: cost ?? null,
      provider: provider ?? cur.provider,
      billed: billed ?? false,
    };
  }
  if (obj === "chat.completion.chunk") {
    const choices = evt.choices as
      | Array<{
          delta?: { content?: string; reasoning_content?: string };
          finish_reason?: string | null;
        }>
      | undefined;
    const usage = evt.usage as
      | {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          reasoning_tokens?: number;
        }
      | undefined;
    let content = cur.content;
    let reasoning = cur.reasoning;
    if (choices) {
      for (const ch of choices) {
        if (ch?.delta?.content) content += ch.delta.content;
        if (ch?.delta?.reasoning_content) {
          reasoning += ch.delta.reasoning_content;
        }
      }
    }
    return {
      ...cur,
      content,
      reasoning,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            reasoningTokens: usage.reasoning_tokens,
          }
        : cur.usage,
    };
  }
  if (obj === "error" || (evt.error && typeof evt.error === "object")) {
    const e =
      (evt.error as { message?: string } | undefined)?.message ?? "error";
    return { ...cur, done: true, error: e };
  }
  return cur;
}

export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function formatUnits(units: number, currency: string): string {
  // High-precision estimate display still respects ISO exponent (not /100).
  const exp = currencyExponent(currency);
  const major = units / 10 ** exp;
  return `${currency.toUpperCase()} ${major.toFixed(Math.max(exp, 4))}`;
}

export async function safeErr(res: Response): Promise<string> {
  try {
    const txt = await res.text();
    try {
      const j = JSON.parse(txt) as { error?: { message?: string } };
      return j.error?.message ?? (txt.slice(0, 200) || `HTTP ${res.status}`);
    } catch {
      return txt.slice(0, 200) || `HTTP ${res.status}`;
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}
