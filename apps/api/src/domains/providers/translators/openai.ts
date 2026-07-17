/**
 * Thin OpenAI request translator over shared adapter helpers (task 9.7).
 * Protocol encoding stays in providers/openai-compatible + http/renderers.
 */

import {
  authHeaders,
  buildChatBody,
  joinUrl,
  parseOpenAIUsageResult,
  parseUsage,
} from "../../../providers/openai-compatible.ts";
import {
  OPENAI_CHAT_COMPLETION_ID_PREFIX,
  OPENAI_SSE_DONE_PAYLOAD,
} from "../../../providers/openai-protocol.ts";
import type { AdapterContext, ChatRequest } from "../../../providers/types.ts";
import { extractOpenAIUsage } from "../usage.ts";

export {
  authHeaders,
  buildChatBody,
  joinUrl,
  parseOpenAIUsageResult,
  parseUsage,
  OPENAI_CHAT_COMPLETION_ID_PREFIX,
  OPENAI_SSE_DONE_PAYLOAD,
};

/** Build OpenAI chat/completions URL + JSON body for shared workflow. */
export function translateOpenAIChatRequest(
  ctx: AdapterContext,
  req: ChatRequest,
  stream: boolean,
): {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
} {
  return {
    url: joinUrl(ctx.baseUrl, "/chat/completions"),
    headers: {
      ...authHeaders(ctx),
      "content-type": "application/json",
    },
    body: buildChatBody(req, stream),
  };
}

/** Closed usage outcome from raw OpenAI usage field. */
export function translateOpenAIUsage(raw: unknown) {
  return extractOpenAIUsage(raw);
}

export function isOpenAISseDone(data: string): boolean {
  return data === OPENAI_SSE_DONE_PAYLOAD;
}
