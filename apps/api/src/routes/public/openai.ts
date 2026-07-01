import { Hono } from "hono";
import { z } from "zod";
import { getDb, type ModelDoc } from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { requireCustomerKey } from "../../middleware/public-auth.ts";
import {
  preFlight,
  callWithFallback,
  streamWithFallback,
  computeCharges,
  settleUsage,
  BillingError,
} from "../../lib/billing.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../../providers/index.ts";

const publicOpenAI = new Hono<{ Variables: PublicAuthVariables }>();
// Scope auth to /v1/* only. Mounting this sub-app at "/" in index.ts means a
// "*" pattern would run auth on every path (including SPA routes like /login)
// and 401 browser navigations before they reach the SPA fallback. Constrain to
// the public API namespace so non-/v1 paths fall through to notFound/SPA.
publicOpenAI.use("/v1/*", requireCustomerKey);

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
  const apiKey = c.get("apiKey");
  const models = await db.models
    .find({ organizationId: orgId, active: true })
    .toArray();
  const filtered = apiKey.modelWhitelist.length > 0
    ? models.filter((m) => apiKey.modelWhitelist.includes(m.aliasId))
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

publicOpenAI.post("/v1/chat/completions", async (c) => {
  let body: z.infer<typeof chatCompletionBody>;
  try {
    body = chatCompletionBody.parse(await c.req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "invalid body";
    return c.json(formatOpenAIError("invalid_request", msg), 400 as 400);
  }

  const orgId = c.get("orgId");
  const customer = c.get("customer");
  const apiKey = c.get("apiKey");
  const stream = body.stream ?? false;

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

  let preflightResult: { model: ModelDoc; rules: Awaited<ReturnType<typeof import("../../lib/rate-limits.ts").getEffectiveRules>> };
  try {
    preflightResult = await preFlight({
      orgId,
      customerId: customer._id,
      apiKeyModelWhitelist: apiKey.modelWhitelist,
      aliasId: body.model,
      estimatedTokens: 0,
      estimatedSpendMinor: 0,
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

  const { model, rules } = preflightResult;
  const start = Date.now();

  if (!stream) {
    try {
      const outcome = await callWithFallback({ orgId, model, request });
      const durationMs = Date.now() - start;
      const charges = computeCharges({ entry: outcome.entry, model, usage: outcome.response.usage });
      await settleUsage({
        orgId,
        customerId: customer._id,
        apiKeyId: apiKey._id,
        model,
        entry: outcome.entry,
        provider: outcome.provider,
        protocol: "openai",
        usage: outcome.response.usage,
        costMinor: charges.costMinor,
        priceMinor: charges.priceMinor,
        currency: charges.currency,
        providerRequestId: outcome.response.providerRequestId,
        status: 200,
        durationMs,
        rules,
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
  let finishReason = "stop";
  let activeEntry: import("@tokenpanel/db").ModelEntryDoc | null = null;
  let activeProviderId: import("mongodb").ObjectId | null = null;

  const streamGen = streamWithFallback({ orgId, model, request });
  const encoder = new TextEncoder();

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        for await (const { entry, provider, chunk } of streamGen) {
          activeEntry = entry;
          activeProviderId = provider._id;
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
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.usage) {
              promptTokens = chunk.usage.promptTokens;
              completionTokens = chunk.usage.completionTokens;
              reasoningTokens = chunk.usage.reasoningTokens ?? 0;
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
              cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
            }
          } else if (chunk.type === "error") {
            enqueue(formatOpenAIError("upstream_error", chunk.error?.message ?? "stream error"));
          }
        }
        enqueue({
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        });
        if (promptTokens > 0 || completionTokens > 0) {
          enqueue({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
              ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
              ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
            },
          });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        enqueue(formatOpenAIError("upstream_error", err instanceof Error ? err.message : "stream failed"));
      } finally {
        controller.close();
        const durationMs = Date.now() - start;
        const totalTokens = promptTokens + completionTokens;
        const usage = { promptTokens, completionTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
        if (activeEntry && activeProviderId && (promptTokens > 0 || completionTokens > 0)) {
          const db = await getDb();
          const providerDoc = await db.providers.findOne({ _id: activeProviderId });
          if (providerDoc && activeEntry) {
            const charges = computeCharges({ entry: activeEntry, model, usage });
            await settleUsage({
              orgId,
              customerId: customer._id,
              apiKeyId: apiKey._id,
              model,
              entry: activeEntry,
              provider: providerDoc,
              protocol: "openai",
              usage,
              costMinor: charges.costMinor,
              priceMinor: charges.priceMinor,
              currency: charges.currency,
              status: 200,
              durationMs,
              rules,
            });
          }
        }
      }
    },
  });

  return new Response(body$, {
    headers: c.res.headers,
    status: 200,
  });
});

export default publicOpenAI;