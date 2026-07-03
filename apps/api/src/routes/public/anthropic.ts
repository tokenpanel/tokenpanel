import { Hono } from "hono";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { getDb, type ModelDoc, type ModelEntryDoc } from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { requireCustomerKey } from "../../middleware/public-auth.ts";
import {
  preFlight,
  callWithFallback,
  streamWithFallback,
  computeCharges,
  settleUsage,
  estimatePromptTokens,
  BillingError,
} from "../../lib/billing.ts";
import type { ChatRequest, ChatMessage } from "../../providers/index.ts";

const publicAnthropic = new Hono<{ Variables: PublicAuthVariables }>();
// Scope auth to /v1/* only (see openai.ts for the full rationale).
publicAnthropic.use("/v1/*", requireCustomerKey);

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

publicAnthropic.post("/v1/messages", async (c) => {
  let body: z.infer<typeof messagesBody>;
  try {
    body = messagesBody.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid body";
    return c.json(anthropicError("invalid_request_error", msg), 400 as 400);
  }

  const orgId = c.get("orgId");
  const customer = c.get("customer");
  const apiKey = c.get("apiKey");
  const stream = body.stream ?? false;

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

  let preflightResult: { model: ModelDoc; rules: Awaited<ReturnType<typeof import("../../lib/rate-limits.ts").getEffectiveRules>> };
  try {
    preflightResult = await preFlight({
      orgId,
      customerId: customer._id,
      apiKeyModelWhitelist: apiKey.modelWhitelist,
      aliasId: body.model,
      // Conservative pre-call estimate so balance + spend/token limits are
      // enforced BEFORE the paid upstream call (previously 0/0 → no enforcement).
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

  const { model, rules } = preflightResult;
  const start = Date.now();

  if (!stream) {
    try {
      const outcome = await callWithFallback({ orgId, model, request });
      const durationMs = Date.now() - start;
      const charges = computeCharges({ entry: outcome.entry, model, usage: outcome.response.usage });
      try {
        await settleUsage({
          orgId,
          customerId: customer._id,
          apiKeyId: apiKey._id,
          model,
          entry: outcome.entry,
          provider: outcome.provider,
          protocol: "anthropic",
          usage: outcome.response.usage,
          costMinor: charges.costMinor,
          priceMinor: charges.priceMinor,
          currency: charges.currency,
          providerRequestId: outcome.response.providerRequestId,
          status: 200,
          durationMs,
          rules,
        });
      } catch (settleErr) {
        // The upstream call already succeeded; a settlement failure must not
        // turn a 200 into a 502. Log so it can be reconciled (dxe).
        console.error("[messages] settlement failed (non-stream):", settleErr);
      }

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
  let stopReason = "end_turn";
  let activeEntry: ModelEntryDoc | null = null;
  let activeProviderId: ObjectId | null = null;
  let blockStarted = false;

  const encoder = new TextEncoder();
  const streamGen = streamWithFallback({ orgId, model, request });

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (event: string, obj: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
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
          activeProviderId = provider._id;
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
            if (chunk.finishReason) stopReason = chunk.finishReason;
            if (chunk.usage) {
              promptTokens = chunk.usage.promptTokens;
              completionTokens = chunk.usage.completionTokens;
              reasoningTokens = chunk.usage.reasoningTokens ?? 0;
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
              cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
            }
          } else if (chunk.type === "error") {
            enqueue("error", { type: "error", error: { type: "upstream_error", message: chunk.error?.message ?? "stream error" } });
          }
        }

        if (blockStarted) {
          enqueue("content_block_stop", { type: "content_block_stop", index: 0 });
        }
        enqueue("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: completionTokens },
        });
        enqueue("message_stop", { type: "message_stop" });
      } catch (err) {
        enqueue("error", { type: "error", error: { type: "upstream_error", message: err instanceof Error ? err.message : "stream failed" } });
      } finally {
        controller.close();
        const durationMs = Date.now() - start;
        const totalTokens = promptTokens + completionTokens;
        const usage = { promptTokens, completionTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
        if (activeEntry && activeProviderId && (promptTokens > 0 || completionTokens > 0)) {
          // Stream-safe settlement: the client has already received message_stop,
          // so a settlement failure cannot be surfaced to it. Wrap + log so
          // failures are reliable to reconcile instead of silently lost (dxe).
          try {
            const db = await getDb();
            const providerDoc = await db.providers.findOne({ _id: activeProviderId });
            if (providerDoc) {
              const charges = computeCharges({ entry: activeEntry, model, usage });
              await settleUsage({
                orgId,
                customerId: customer._id,
                apiKeyId: apiKey._id,
                model,
                entry: activeEntry,
                provider: providerDoc,
                protocol: "anthropic",
                usage,
                costMinor: charges.costMinor,
                priceMinor: charges.priceMinor,
                currency: charges.currency,
                status: 200,
                durationMs,
                rules,
              });
            }
          } catch (settleErr) {
            console.error("[messages] settlement failed (stream):", settleErr);
          }
        }
      }
    },
  });

  return new Response(body$, { headers: c.res.headers, status: 200 });
});

export default publicAnthropic;