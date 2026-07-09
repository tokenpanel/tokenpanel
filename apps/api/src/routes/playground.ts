import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import {
  getDb,
  type ModelDoc,
  type ModelEntryDoc,
  type ProviderDoc,
} from "@tokenpanel/db";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import {
  preFlight,
  callWithFallback,
  streamWithFallback,
  computeCharges,
  settleUsage,
  BillingError,
} from "../lib/billing.ts";
import { getEffectiveRules } from "../lib/rate-limits.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../providers/index.ts";

const playground = new Hono<{ Variables: AuthVariables }>();

// Playground calls upstream providers with the org's decrypted API keys (like
// discover-models), so it is admin-only — a member must not be able to drive
// paid upstream calls or probe provider credentials.
playground.use("*", requireAuth, requireRole("admin"));

const messageSchema = z.object({
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

const chatBody = z.object({
  /** Model alias to test. */
  model: z.string().min(1).max(80),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().nonnegative().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  response_format: z.any().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  /**
   * Optional customer to attribute usage + billing to. When omitted the call
   * is free (admin test mode): no balance debit, no rate-limit counters, but
   * a usage_record is still written with billed=false and a synthetic
   * playground customer id derived from the admin user's org so analytics can
   * filter it out if desired.
   */
  customerId: z.string().min(1).max(64).optional(),
}).passthrough();

function translateMessage(m: z.infer<typeof messageSchema>): ChatMessage {
  let content: string | ContentPart[];
  if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = m.content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text ?? "" };
      if (part.type === "image_url") return { type: "image_url", imageUrl: part.image_url ?? { url: "" } };
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

function formatError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    error: {
      message,
      type:
        code === "rate_limited"
          ? "rate_limit_error"
          : code === "insufficient_balance"
            ? "billing_error"
            : "invalid_request_error",
      code,
      ...(extra ?? {}),
    },
  };
}

/**
 * Resolve (or synthesize) the customer context for a playground call.
 * - With customerId: validate it belongs to this org, load it, load its
 *   effective rate-limit rules so the call is metered exactly like real usage.
 * - Without customerId: synthetic playground context — no balance, no rules,
 *   usage_record still written (billed=false) for cost visibility.
 */
async function resolvePlaygroundContext(orgId: ObjectId, customerIdRaw: string | undefined) {
  const db = await getDb();
  if (!customerIdRaw) {
    return { customer: null, rules: [] as Awaited<ReturnType<typeof getEffectiveRules>> };
  }
  if (!ObjectId.isValid(customerIdRaw)) {
    throw new BillingError(400, "invalid_customer_id", "customerId must be a valid ObjectId");
  }
  const customer = await db.customers.findOne({ _id: new ObjectId(customerIdRaw), organizationId: orgId });
  if (!customer) throw new BillingError(404, "customer_not_found", "Customer not found in this org");
  const rules = await getEffectiveRules(db, customer._id);
  return { customer, rules };
}

playground.post("/chat", zValidator("json", chatBody), async (c) => {
  const orgId = c.get("orgId");
  const body = c.req.valid("json");
  const stream = body.stream ?? false;

  let ctx: { customer: Awaited<ReturnType<typeof resolvePlaygroundContext>>["customer"]; rules: Awaited<ReturnType<typeof getEffectiveRules>> };
  try {
    ctx = await resolvePlaygroundContext(orgId, body.customerId);
  } catch (err) {
    if (err instanceof BillingError) {
      return c.json(formatError(err.code, err.message, err.extra), err.status as 400 | 404);
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
    stop: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : undefined,
    responseFormat: body.response_format,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
    // extra passthrough for top_k / frequency_penalty / presence_penalty / seed
    // and anything else the adapter understands (openai-compatible merges `extra`).
    extra: pickExtras(body),
  };

  let preflight: { model: ModelDoc; rules: Awaited<ReturnType<typeof getEffectiveRules>> };
  try {
    preflight = await preFlight({
      orgId,
      // Use the real customer id when billing; else a zero ObjectId placeholder
      // so preFlight's rate-limit check is a no-op (empty rules).
      customerId: ctx.customer?._id ?? new ObjectId(),
      apiKeyModelWhitelist: [], // admin playground bypasses per-key model whitelist
      aliasId: body.model,
      // Playground is admin-only test mode: no balance pre-check (an admin can
      // test regardless of a selected customer's balance). 0/0 → estimate skipped.
      estimatedPromptTokens: 0,
      maxCompletionTokens: 0,
    });
  } catch (err) {
    if (err instanceof BillingError) {
      const headers: Record<string, string> = {};
      if (err.extra && typeof err.extra["retryAfterSeconds"] === "number") {
        headers["Retry-After"] = String(err.extra["retryAfterSeconds"]);
      }
      return c.json(formatError(err.code, err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502, headers);
    }
    throw err;
  }

  const { model } = preflight;
  const rules = ctx.rules; // use customer's real rules if a customer was selected
  const start = Date.now();

  // Non-streaming -----------------------------------------------------------
  if (!stream) {
    try {
      const outcome = await callWithFallback({ orgId, model, request });
      const durationMs = Date.now() - start;
      const charges = computeCharges({ entry: outcome.entry, model, usage: outcome.response.usage });

      // Only debit + meter when a real customer is selected. Without a
      // customer, settleUsage still inserts a usage_record (actorKind
      // "playground", billed=false) so admins see cost visibility without
      // charging anyone — previously this used a sentinel ObjectId hack that
      // the new nullable-customerId schema makes unnecessary.
      try {
        await settleUsage({
          orgId,
          actor: {
            actorKind: "playground",
            customerId: ctx.customer?._id ?? null,
            apiKeyId: null,
          },
          model,
          entry: outcome.entry,
          provider: outcome.provider,
          protocol: "openai",
          usage: outcome.response.usage,
          costMinor: charges.costMinor,
          priceMinor: ctx.customer ? charges.priceMinor : 0,
          currency: charges.currency,
          providerRequestId: outcome.response.providerRequestId,
          status: 200,
          durationMs,
          rules,
        });
      } catch (settleErr) {
        console.error("[playground] settlement failed (non-stream):", settleErr);
      }

      const r = outcome.response;
      return c.json({
        id: r.id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        provider: {
          providerId: outcome.provider._id.toHexString(),
          upstreamModelId: outcome.entry.upstreamModelId,
          sdkType: outcome.provider.sdkType,
        },
        choices: r.choices.map((ch) => ({
          index: ch.index,
          message: {
            role: ch.message.role,
            content: ch.message.content,
            reasoning_content: ch.message.reasoning,
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
        cost: { costMinor: charges.costMinor, priceMinor: charges.priceMinor, currency: charges.currency },
        billed: ctx.customer !== null,
      });
    } catch (err) {
      if (err instanceof BillingError) {
        return c.json(formatError(err.code, err.message, err.extra), err.status as 400 | 402 | 403 | 404 | 429 | 502);
      }
      return c.json(formatError("upstream_error", err instanceof Error ? err.message : "upstream failed"), 502 as 502);
    }
  }

  // Streaming ----------------------------------------------------------------
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const id = `playground-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let finishReason = "stop";
  let activeEntry: ModelEntryDoc | null = null;
  let activeProvider: ProviderDoc | null = null;

  const streamGen = streamWithFallback({ orgId, model, request });
  const encoder = new TextEncoder();

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        // Send a header event so the client can show which provider/model served.
        // Format kept as a chat.completion.chunk so standard OpenAI SSE parsers work;
        // the provider metadata rides on a separate, optional event type.
        enqueue({ id, object: "playground.meta", created, model: body.model });
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
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.usage) {
              promptTokens = chunk.usage.promptTokens;
              completionTokens = chunk.usage.completionTokens;
              reasoningTokens = chunk.usage.reasoningTokens ?? 0;
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0;
              cacheWriteTokens = chunk.usage.cacheWriteTokens ?? 0;
            }
          } else if (chunk.type === "error") {
            enqueue(formatError("upstream_error", chunk.error?.message ?? "stream error"));
          }
        }
        enqueue({
          id,
          object: "chat.completion.chunk",
          created,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        });
        const totalTokens = promptTokens + completionTokens;
        const usagePayload = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
          ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
          ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
        };
        if (promptTokens > 0 || completionTokens > 0) {
          enqueue({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usagePayload });
        }
        // Final cost event so the UI can show $ without re-fetching.
        if (activeEntry && activeProvider && (promptTokens > 0 || completionTokens > 0)) {
          const usage = { promptTokens, completionTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
          const charges = computeCharges({ entry: activeEntry, model, usage });
          // Unified settlement: customer-attributed when a customer is
          // selected (debited), otherwise internal (audit-only).
          try {
            await settleUsage({
              orgId,
              actor: {
                actorKind: "playground",
                customerId: ctx.customer?._id ?? null,
                apiKeyId: null,
              },
              model,
              entry: activeEntry,
              provider: activeProvider,
              protocol: "openai",
              usage,
              costMinor: charges.costMinor,
              priceMinor: ctx.customer ? charges.priceMinor : 0,
              currency: charges.currency,
              status: 200,
              durationMs: Date.now() - start,
              rules,
            });
          } catch (settleErr) {
            console.error("[playground] settlement failed (stream):", settleErr);
          }
          enqueue({
            id,
            object: "playground.cost",
            created,
            model: body.model,
            provider: {
              providerId: activeProvider._id.toHexString(),
              upstreamModelId: activeEntry.upstreamModelId,
              sdkType: activeProvider.sdkType,
            },
            cost: { costMinor: charges.costMinor, priceMinor: charges.priceMinor, currency: charges.currency },
            billed: ctx.customer !== null,
          });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        enqueue(formatError("upstream_error", err instanceof Error ? err.message : "stream failed"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body$, {
    headers: c.res.headers,
    status: 200,
  });
});

/**
 * Forward provider-specific params the ChatRequest type doesn't model
 * explicitly. The openai-compatible adapter merges `extra` into the upstream
 * body via Object.assign, so top_k / frequency_penalty / presence_penalty /
 * seed reach the provider when supported.
 */
function pickExtras(body: z.infer<typeof chatBody>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (body.top_k !== undefined) extra.top_k = body.top_k;
  if (body.frequency_penalty !== undefined) extra.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) extra.presence_penalty = body.presence_penalty;
  if (body.seed !== undefined) extra.seed = body.seed;
  return extra;
}

export default playground;
export { playground };