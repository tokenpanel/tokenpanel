import { Hono } from "hono";
import { z } from "zod";
import type { ObjectId } from "mongodb";
import type { ModelDoc, ModelEntryDoc, ProviderDoc } from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import {
  preFlight,
  callWithFallback,
  streamWithFallback,
  cacheAccountingForProtocol,
  computeCharges,
  settleUsageOrOutbox,
  estimatePromptTokens,
  resolveModel,
  releasePreFlightReservation,
  BillingError,
  type BalanceReservation,
} from "../../lib/billing.ts";
import { normalizeProcessedTotalTokens } from "../../providers/provider-usage.ts";
import {
  resolveChatContext,
  actorForChatContext,
  billableCustomerId,
  modelWhitelistForContext,
  V1ChatError,
  type ChatContext,
} from "../../lib/v1-chat-context.ts";
import { getEffectiveRules } from "../../lib/rate-limits.ts";
import type { ChatRequest, ChatMessage } from "../../providers/index.ts";
import { newGatewayRequestId } from "../../services/settlement-outbox.ts";

const publicAnthropic = new Hono<{ Variables: PublicAuthVariables }>();
// Auth is mounted once on the parent app for /v1/* (index.ts) so openai +
// anthropic handlers do not double-authenticate.

const anthropicContentBlock = z.object({
  type: z.enum(["text", "image", "tool_use", "tool_result"]),
  text: z.string().optional(),
  source: z.object({ type: z.string(), media_type: z.string(), data: z.string() }).optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.any().optional(),
  tool_use_id: z.string().optional(),
  content: z.any().optional(),
}).passthrough();

const anthropicMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(anthropicContentBlock)]),
});

const messagesBody = z.object({
  model: z.string().min(1),
  messages: z.array(anthropicMessage).min(1),
  system: z.union([z.string(), z.array(z.any())]).optional(),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().positive(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  /**
   * Management-key-only attribute (see openai.ts). Ignored for customer keys.
   * Stripped before forwarding upstream.
   */
  customerEmail: z.string().email().max(254).optional(),
}).passthrough();

export function translateAnthropicMessage(m: z.infer<typeof anthropicMessage>): ChatMessage {
  let content: string | import("../../providers/index.ts").ContentPart[];
  if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = m.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text ?? "" };
      if (block.type === "image" && block.source) {
        return { type: "image_url", imageUrl: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
      }
      return { type: "text", text: "" };
    });
  }
  return { role: m.role, content };
}

export function anthropicError(type: string, message: string, extra?: Record<string, unknown>) {
  return {
    type: "error",
    error: { type, message, ...(extra ?? {}) },
  };
}

/**
 * Resolve model + rules. Customer / management_attributed paths run full
 * preFlight (model access + limits + balance). Internal management calls skip
 * balance/limit checks (no customer) but still validate model existence.
 */
async function resolveModelAndRules(params: {
  orgId: ObjectId;
  ctx: ChatContext;
  aliasId: string;
  estimatedPromptTokens: number;
  maxCompletionTokens?: number;
}): Promise<{
  model: ModelDoc;
  rules: Awaited<ReturnType<typeof getEffectiveRules>>;
  reservation: BalanceReservation | null;
}> {
  const customerId = billableCustomerId(params.ctx);
  if (customerId === null) {
    const model = await resolveModel(params.orgId, params.aliasId);
    return { model, rules: [], reservation: null };
  }
  return preFlight({
    orgId: params.orgId,
    customerId,
    apiKeyModelWhitelist: modelWhitelistForContext(params.ctx),
    aliasId: params.aliasId,
    estimatedPromptTokens: params.estimatedPromptTokens,
    maxCompletionTokens: params.maxCompletionTokens,
  });
}

publicAnthropic.post("/v1/messages", async (c) => {
  let body: z.infer<typeof messagesBody>;
  try {
    body = messagesBody.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid body";
    return c.json(anthropicError("invalid_request_error", msg), 400 as 400);
  }

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return c.json(anthropicError("authentication_error", "missing principal"), 401 as 401);
  }
  const stream = body.stream ?? false;

  let ctx: ChatContext;
  try {
    ctx = await resolveChatContext({
      principal,
      customerEmail: body.customerEmail,
    });
  } catch (err) {
    if (err instanceof V1ChatError) {
      const type =
        err.code === "missing_scope"
          ? "permission_error"
          : err.code === "customer_not_found"
            ? "not_found_error"
            : "invalid_request_error";
      return c.json(anthropicError(type, err.message), err.status as 401 | 403 | 404);
    }
    throw err;
  }

  const messages: ChatMessage[] = body.messages.map(translateAnthropicMessage);
  if (body.system) {
    const sysText = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    messages.unshift({ role: "system", content: sysText });
  }

  const request: ChatRequest = {
    model: body.model,
    messages,
    stream,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    tools: body.tools,
    toolChoice: body.tool_choice,
    stop: body.stop_sequences,
  };

  let preflightResult: {
    model: ModelDoc;
    rules: Awaited<ReturnType<typeof getEffectiveRules>>;
    reservation: BalanceReservation | null;
  };
  try {
    preflightResult = await resolveModelAndRules({
      orgId,
      ctx,
      aliasId: body.model,
      estimatedPromptTokens: estimatePromptTokens(request.messages),
      maxCompletionTokens: body.max_tokens,
    });
  } catch (err) {
    if (err instanceof BillingError) {
      const headers: Record<string, string> = {};
      if (err.extra && typeof err.extra["retryAfterSeconds"] === "number") {
        headers["Retry-After"] = String(err.extra["retryAfterSeconds"]);
      }
      return c.json(anthropicError(err.code === "rate_limited" ? "rate_limit_error" : err.code === "insufficient_balance" ? "billing_error" : "invalid_request_error", err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502, headers);
    }
    throw err;
  }

  const { model, rules, reservation } = preflightResult;
  const reservedMinor = reservation?.reservedMinor ?? 0;
  const actor = actorForChatContext(ctx);
  const start = Date.now();
  // One stable id for this gateway request — shared by settle + outbox retries.
  const gatewayRequestId = newGatewayRequestId();

  if (!stream) {
    try {
      const outcome = await callWithFallback({ orgId, model, request });
      const durationMs = Date.now() - start;
      const charges = computeCharges({ entry: outcome.entry, model, usage: outcome.response.usage });
      const priceMinor = ctx.kind === "management_internal" ? 0 : charges.priceMinor;
      // Enqueue failures must not be swallowed — they surface as 502 so the
      // request is not treated as free completed work.
      await settleUsageOrOutbox({
        orgId,
        actor,
        model,
        entry: outcome.entry,
        provider: outcome.provider,
        protocol: "anthropic",
        response: outcome.response,
        providerRequestId: outcome.response.providerRequestId,
        gatewayRequestId,
        status: 200,
        durationMs,
        rules,
        priceMinorOverride: priceMinor,
        occurredAt: new Date(start),
        reservedMinor,
      });

      const r = outcome.response;
      const choice = r.choices[0];
      const textContent = typeof choice?.message.content === "string" ? choice.message.content : "";
      const contentBlocks: unknown[] = [{ type: "text", text: textContent }];
      const toolCalls = choice?.message.toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const t = tc as { id?: string; function?: { name?: string; arguments?: string } };
          contentBlocks.push({
            type: "tool_use",
            id: t.id ?? "",
            name: t.function?.name ?? "",
            input: (() => { try { return JSON.parse(t.function?.arguments ?? "{}"); } catch { return {}; } })(),
          });
        }
      }

      return c.json({
        id: r.id,
        type: "message",
        role: "assistant",
        model: body.model,
        content: contentBlocks,
        stop_reason: choice?.finishReason ?? "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: r.usage.promptTokens,
          output_tokens: r.usage.completionTokens,
          ...(r.usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: r.usage.cacheReadTokens } : {}),
          ...(r.usage.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: r.usage.cacheWriteTokens } : {}),
        },
      });
    } catch (err) {
      await releasePreFlightReservation(reservation);
      if (err instanceof BillingError) {
        return c.json(anthropicError(err.code === "rate_limited" ? "rate_limit_error" : err.code === "insufficient_balance" ? "billing_error" : "invalid_request_error", err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502);
      }
      return c.json(anthropicError("upstream_error", err instanceof Error ? err.message : "upstream failed"), 502 as 502);
    }
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const messageId = `msg_${Date.now().toString(36)}`;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  /** Provider-reported total from chunk.usage (may exceed prompt+completion). */
  let reportedTotalTokens: number | undefined;
  let cacheAccounting = cacheAccountingForProtocol("anthropic");
  let stopReason = "end_turn";
  let activeEntry: ModelEntryDoc | null = null;
  // Retain the yielded ProviderDoc (do not re-fetch — concurrent delete would
  // silently skip settlement/outbox).
  let activeProvider: ProviderDoc | null = null;
  let blockStarted = false;
  /** Only true when adapter observed message_stop (not truncated EOF). */
  let streamComplete = false;
  /** Exactly one terminal error event per stream (yielded, truncation, or catch). */
  let terminalErrorEmitted = false;

  const encoder = new TextEncoder();
  const streamGen = streamWithFallback({ orgId, model, request });

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (event: string, obj: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
      };
      const closeOpenBlock = () => {
        if (!blockStarted) return;
        enqueue("content_block_stop", { type: "content_block_stop", index: 0 });
        blockStarted = false;
      };
      const enqueueTerminalError = (type: string, message: string) => {
        if (terminalErrorEmitted) return;
        terminalErrorEmitted = true;
        closeOpenBlock();
        enqueue("error", { type: "error", error: { type, message } });
      };
      try {
        enqueue("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        enqueue("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        blockStarted = true;

        for await (const { entry, provider, chunk } of streamGen) {
          activeEntry = entry;
          activeProvider = provider;
          if (chunk.type === "delta") {
            if (chunk.delta?.content !== undefined) {
              enqueue("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: chunk.delta.content },
              });
            }
            if (chunk.delta?.reasoning !== undefined) {
              enqueue("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "thinking_delta", thinking: chunk.delta.reasoning },
              });
            }
          } else if (chunk.type === "done") {
            if (chunk.streamComplete) streamComplete = true;
            if (chunk.finishReason) stopReason = chunk.finishReason;
            if (chunk.streamComplete && chunk.usage) {
              promptTokens = chunk.usage.promptTokens;
              completionTokens = chunk.usage.completionTokens;
              reasoningTokens = chunk.usage.reasoningTokens ?? 0;
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
              cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
              // Retain provider total for the normalizer (do not drop totalTokens).
              reportedTotalTokens =
                typeof chunk.usage.totalTokens === "number"
                  ? chunk.usage.totalTokens
                  : undefined;
              if (
                chunk.usage.cacheAccounting === "subset" ||
                chunk.usage.cacheAccounting === "additive"
              ) {
                cacheAccounting = chunk.usage.cacheAccounting;
              }
            }
          } else if (chunk.type === "error") {
            enqueueTerminalError(
              "upstream_error",
              chunk.error?.message ?? "stream error",
            );
          }
        }

        if (!streamComplete) {
          // Truncated / failed stream: one error only (skip if already emitted).
          // Never stop_reason "error" + message_stop.
          enqueueTerminalError(
            "stream_truncated",
            "Upstream stream ended without message_stop; response may be incomplete",
          );
        } else {
          closeOpenBlock();
          enqueue("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: completionTokens },
          });
          enqueue("message_stop", { type: "message_stop" });
        }
      } catch (err) {
        // Error path: no message_stop / success-style terminal. One error only.
        enqueueTerminalError(
          "upstream_error",
          err instanceof Error ? err.message : "stream failed",
        );
      } finally {
        controller.close();
        const durationMs = Date.now() - start;
        const normalizedTotal = normalizeProcessedTotalTokens({
          promptTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: reportedTotalTokens,
          cacheAccounting,
        });
        const usage = {
          promptTokens,
          completionTokens,
          reasoningTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: normalizedTotal ?? 0,
          cacheAccounting,
        };
        if (activeEntry && activeProvider) {
          try {
            const charges = computeCharges({
              entry: activeEntry,
              model,
              usage,
              cacheAccounting,
            });
            const priceMinor =
              ctx.kind === "management_internal" ? 0 : charges.priceMinor;
            // Truncated streams / overflow must not settle partial usage as reported.
            const hasAuthoritativeUsage =
              streamComplete &&
              normalizedTotal !== null &&
              (promptTokens > 0 || completionTokens > 0);
            await settleUsageOrOutbox({
              orgId,
              actor,
              model,
              entry: activeEntry,
              provider: activeProvider,
              protocol: "anthropic",
              gatewayRequestId,
              providerUsage: hasAuthoritativeUsage
                ? { status: "reported", usage }
                : {
                    status: "missing",
                    reason: !streamComplete
                      ? "stream_truncated"
                      : normalizedTotal === null
                        ? "usage_overflow"
                        : "stream_usage_absent",
                  },
              status: 200,
              durationMs,
              rules,
              priceMinorOverride: priceMinor,
              occurredAt: new Date(start),
              reservedMinor,
            });
          } catch (settleErr) {
            // Stream already committed to client; outbox enqueue must still
            // surface in logs (settleUsageOrOutbox does not swallow enqueue fails).
            console.error("[messages] stream settlement/outbox failed:", settleErr);
          }
        }
      }
    },
  });

  return new Response(body$, { headers: c.res.headers, status: 200 });
});

export default publicAnthropic;