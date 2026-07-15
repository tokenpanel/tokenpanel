import { Hono } from "hono";
import { z } from "zod";
import { getDb, type ModelDoc } from "@tokenpanel/db";
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
import type { ChatRequest, ChatMessage, ContentPart } from "../../providers/index.ts";
import { newGatewayRequestId } from "../../services/settlement-outbox.ts";

const publicOpenAI = new Hono<{ Variables: PublicAuthVariables }>();
// Auth is mounted once on the parent app for /v1/* (index.ts) so openai +
// anthropic handlers do not double-authenticate. Handlers branch on the
// resolved principal (tp_live_ vs tp_mgmt_).

export function toOpenAIModel(m: ModelDoc) {
  return {
    id: m.aliasId,
    object: "model" as const,
    created: Math.floor(m.createdAt.getTime() / 1000),
    owned_by: "tokenpanel",
  };
}

publicOpenAI.get("/v1/models", async (c) => {
  const db = await getDb();
  const orgId = c.get("orgId");
  const principal = c.get("principal");
  // Management principals need an explicit scope to list models. We accept
  // either models:read (the canonical "list models" scope) or chat:write (so
  // a chat-only integration can discover model aliases to call /v1/chat with).
  // Customer keys are unchanged — no scope system, model whitelist still
  // applies.
  if (principal && principal.kind === "management") {
    const scopes = principal.managementKey.scopes;
    const allowed = scopes.includes("models:read") || scopes.includes("chat:write");
    if (!allowed) {
      return c.json(formatOpenAIError("missing_scope", "Management key lacks models:read or chat:write"), 403 as 403);
    }
  }
  const models = await db.models
    .find({ organizationId: orgId, active: true })
    .toArray();
  // Model whitelist applies only to customer keys. Management keys have no
  // per-key whitelist — scope (chat:write / models:read) is the gate.
  const whitelist =
    principal && principal.kind === "customer" ? principal.apiKey.modelWhitelist : [];
  const filtered = whitelist.length > 0
    ? models.filter((m) => whitelist.includes(m.aliasId))
    : models;
  return c.json({ object: "list", data: filtered.map(toOpenAIModel) });
});

const openAIMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.enum(["text", "image_url", "input_audio"]),
        text: z.string().optional(),
        image_url: z.object({ url: z.string() }).optional(),
        input_audio: z.object({ data: z.string() }).optional(),
      }).passthrough(),
    ),
  ]),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
});

const chatCompletionBody = z.object({
  model: z.string().min(1),
  messages: z.array(openAIMessage).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  response_format: z.any().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  n: z.number().int().positive().optional(),
  /**
   * Management-key-only attribute. When present, the call bills + meters the
   * resolved customer inside the key's org. Ignored for customer keys (those
   * already attribute to the key's owner). Stripped before forwarding upstream
   * — providers reject unknown fields.
   */
  customerEmail: z.string().email().max(254).optional(),
}).passthrough();

export function translateMessage(m: z.infer<typeof openAIMessage>): ChatMessage {
  let content: string | ContentPart[];
  if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = m.content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text ?? "" };
      }
      if (part.type === "image_url") {
        return { type: "image_url", imageUrl: part.image_url ?? { url: "" } };
      }
      return { type: "input_audio", inputData: part.input_audio?.data ?? "" };
    });
  }
  return {
    role: m.role,
    content,
    toolCallId: m.tool_call_id,
    toolCalls: m.tool_calls,
  };
}

export function formatOpenAIError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    error: {
      message,
      type: code === "rate_limited" ? "rate_limit_error" : code === "insufficient_balance" ? "billing_error" : "invalid_request_error",
      code,
      ...(extra ?? {}),
    },
  };
}

/**
 * Resolve the model + (optional) preflight rules for a chat request.
 *
 * Customer / management_attributed paths run full preFlight — model access,
 * rate limits, and balance check — against the billable customer. Org-internal
 * management calls skip balance + rate-limit checks (no customer to bill or
 * meter) but still validate model existence + activeness via resolveModel.
 */
async function resolveModelAndRules(params: {
  orgId: import("mongodb").ObjectId;
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
    // Internal management call — no customer to bill or meter. Still validate
    // the model exists + is active so 404s surface early.
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

publicOpenAI.post("/v1/chat/completions", async (c) => {
  let body: z.infer<typeof chatCompletionBody>;
  try {
    body = chatCompletionBody.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid body";
    return c.json(formatOpenAIError("invalid_request", msg), 400 as 400);
  }

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return c.json(formatOpenAIError("unauthorized", "missing principal"), 401 as 401);
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
      return c.json(formatOpenAIError(err.code, err.message), err.status as 401 | 403 | 404);
    }
    throw err;
  }

  const request: ChatRequest = {
    model: body.model,
    messages: body.messages.map(translateMessage),
    stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    topP: body.top_p,
    tools: body.tools,
    toolChoice: body.tool_choice,
    stop: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : undefined,
    responseFormat: body.response_format,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
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
      maxCompletionTokens: body.max_tokens ?? body.max_completion_tokens,
    });
  } catch (err) {
    if (err instanceof BillingError) {
      const headers: Record<string, string> = {};
      if (err.extra && typeof err.extra["retryAfterSeconds"] === "number") {
        headers["Retry-After"] = String(err.extra["retryAfterSeconds"]);
      }
      return c.json(formatOpenAIError(err.code, err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502, headers);
    }
    throw err;
  }

  const { model, rules, reservation } = preflightResult;
  const reservedMinor = reservation?.reservedMinor ?? 0;
  const actor = actorForChatContext(ctx);
  const start = Date.now();
  const gatewayRequestId = newGatewayRequestId();

  if (!stream) {
    try {
      const outcome = await callWithFallback({ orgId, model, request });
      const durationMs = Date.now() - start;
      const charges = computeCharges({ entry: outcome.entry, model, usage: outcome.response.usage });
      // Internal management calls are not billed — they record usage for
      // analytics only (priceMinor 0). Attributed + customer paths bill
      // normally via the resolved customer.
      const priceMinor = ctx.kind === "management_internal" ? 0 : charges.priceMinor;
      // Business settle failures enqueue outbox (return settled:false).
      // Enqueue failures throw and become 502 — never log-only free settle.
      await settleUsageOrOutbox({
        orgId,
        actor,
        model,
        entry: outcome.entry,
        provider: outcome.provider,
        protocol: "openai",
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
      return c.json({
        id: r.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: r.choices.map((ch) => ({
          index: ch.index,
          message: {
            role: ch.message.role,
            content: ch.message.content,
            tool_calls: ch.message.toolCalls,
          },
          finish_reason: ch.finishReason,
        })),
        usage: {
          prompt_tokens: r.usage.promptTokens,
          completion_tokens: r.usage.completionTokens,
          total_tokens: r.usage.totalTokens,
          ...(r.usage.reasoningTokens !== undefined ? { reasoning_tokens: r.usage.reasoningTokens } : {}),
          ...(r.usage.cacheReadTokens !== undefined ? { prompt_tokens_details: { cached_tokens: r.usage.cacheReadTokens } } : {}),
        },
      });
    } catch (err) {
      await releasePreFlightReservation(reservation);
      if (err instanceof BillingError) {
        return c.json(formatOpenAIError(err.code, err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502);
      }
      return c.json(formatOpenAIError("upstream_error", err instanceof Error ? err.message : "upstream failed"), 502 as 502);
    }
  }

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  /** Provider-reported total from chunk.usage (may exceed prompt+completion). */
  let reportedTotalTokens: number | undefined;
  let cacheAccounting = cacheAccountingForProtocol("openai");
  let finishReason = "stop";
  let activeEntry: import("@tokenpanel/db").ModelEntryDoc | null = null;
  // Retain the yielded ProviderDoc (do not re-fetch — concurrent delete would
  // silently skip settlement/outbox).
  let activeProvider: import("@tokenpanel/db").ProviderDoc | null = null;
  /** Only true when adapter observed OpenAI `[DONE]` (not truncated EOF). */
  let streamComplete = false;
  /** Exactly one terminal error event per stream (yielded, truncation, or catch). */
  let terminalErrorEmitted = false;

  const streamGen = streamWithFallback({ orgId, model, request });
  const encoder = new TextEncoder();

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const enqueueTerminalError = (code: string, message: string) => {
        if (terminalErrorEmitted) return;
        terminalErrorEmitted = true;
        enqueue(formatOpenAIError(code, message));
      };
      try {
        for await (const { entry, provider, chunk } of streamGen) {
          activeEntry = entry;
          activeProvider = provider;
          if (chunk.type === "delta") {
            const delta: Record<string, unknown> = {};
            if (chunk.delta?.content !== undefined) delta.content = chunk.delta.content;
            if (chunk.delta?.reasoning !== undefined) delta.reasoning_content = chunk.delta.reasoning;
            if (chunk.delta?.toolCalls !== undefined) delta.tool_calls = chunk.delta.toolCalls;
            enqueue({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: null }],
            });
          } else if (chunk.type === "done") {
            if (chunk.streamComplete) streamComplete = true;
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.streamComplete && chunk.usage) {
              promptTokens = chunk.usage.promptTokens;
              completionTokens = chunk.usage.completionTokens;
              reasoningTokens = chunk.usage.reasoningTokens ?? 0;
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
              cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
              // Retain provider total (e.g. 10+5 with total 20) for the normalizer.
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
        // Mode-correct total: prefer provider total, never undercount additive cache.
        // null = overflow / unsafe — fail-closed for settlement below.
        const normalizedTotal = normalizeProcessedTotalTokens({
          promptTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          totalTokens: reportedTotalTokens,
          cacheAccounting,
        });
        if (!streamComplete) {
          // Truncated / failed stream: emit error only — never finish_reason
          // "error" + [DONE]. Skip if an upstream error chunk already terminalled.
          enqueueTerminalError(
            "stream_truncated",
            "Upstream stream ended without a terminal event; response may be incomplete",
          );
        } else {
          enqueue({
            id, object: "chat.completion.chunk", created, model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          });
          if (promptTokens > 0 || completionTokens > 0) {
            enqueue({
              id, object: "chat.completion.chunk", created, model: body.model,
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: normalizedTotal ?? 0,
                ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
                ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
              },
            });
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      } catch (err) {
        // Error path: no success-style finish_reason / [DONE]. One terminal only.
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
        // Always settle or outbox when a provider attempt yielded context.
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
              protocol: "openai",
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
            console.error("[chat/completions] stream settlement/outbox failed:", settleErr);
          }
        }
      }
    },
  });

  return new Response(body$, { headers: c.res.headers, status: 200 });
});

export default publicOpenAI;