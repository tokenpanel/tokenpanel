/**
 * Thin Anthropic request translator over shared adapter helpers (task 9.7).
 */

import {
  buildBody,
  headers,
  joinUrl,
  parseAnthropicUsageResult,
  mapUsage,
  splitSystemAndMessages,
  stringifyContent,
  translateTools,
} from "../../../providers/anthropic-compatible.ts";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} from "../../../providers/anthropic-protocol.ts";
import type { AdapterContext, ChatRequest } from "../../../providers/types.ts";
import { extractAnthropicUsage } from "../usage.ts";

export {
  buildBody,
  headers,
  joinUrl,
  parseAnthropicUsageResult,
  mapUsage,
  splitSystemAndMessages,
  stringifyContent,
  translateTools,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
};

/** Build Anthropic /v1/messages URL + JSON body for shared workflow. */
export function translateAnthropicMessagesRequest(
  ctx: AdapterContext,
  req: ChatRequest,
  stream: boolean,
): {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
} {
  return {
    url: joinUrl(ctx.baseUrl, "/v1/messages"),
    headers: {
      ...headers(ctx),
      "content-type": "application/json",
    },
    body: buildBody(req, stream),
  };
}

/** Closed usage outcome from raw Anthropic usage field. */
export function translateAnthropicUsage(raw: unknown) {
  return extractAnthropicUsage(raw);
}
