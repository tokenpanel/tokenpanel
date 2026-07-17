import { Hono } from "hono";
import { Cause, Effect, Exit } from "effect";
import { ObjectId } from "mongodb";
import type {
  CustomerDoc,
  ModelDoc,
  ModelEntryDoc,
  ProviderDoc,
  RateLimitRule,
} from "@tokenpanel/db";
import { requireAuth, requireRole, type AuthVariables } from "../middleware/auth.ts";
import { billingAppError } from "../lib/billing-errors.ts";
import { resolveModelOp } from "../domains/billing/workflow.ts";
import { getEffectiveRulesOp } from "../domains/limits/operations.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../providers/index.ts";
import {
  applyDoneUsage,
  classifyGenerationFailure,
  completeGeneration,
  emptyStreamUsage,
  openStreamGeneration,
  type GenerationCompleteResult,
} from "../domains/providers/generation.ts";
import { CustomerRepository } from "../domains/ports/customer-repository.ts";
import {
  formatOpenAIErrorBody,
  openAISseTerminalFromAppError,
} from "../http/renderers/openai.ts";
import { isAppError, SystemError } from "../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../errors/safe-messages.ts";
import {
  mapExitToHttpResponse,
  runOpenAIEffect,
} from "../http/adapters/boundary.ts";
import {
  PlaygroundChatBody,
  sValidator,
} from "../http/validation/index.ts";
import { getAppRuntime } from "../runtime/app-runtime.ts";

const playground = new Hono<{ Variables: AuthVariables }>();

// Playground calls upstream providers with the org's decrypted API keys (like
// discover-models), so it is admin-only — a member must not be able to drive
// paid upstream calls or probe provider credentials.
playground.use("*", requireAuth, requireRole("admin"));

type PlaygroundMessage = PlaygroundChatBody["messages"][number];

function translateMessage(m: PlaygroundMessage): ChatMessage {
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
    toolCalls: m.tool_calls ? [...m.tool_calls] : undefined,
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

type PlaygroundContext = {
  readonly customer: CustomerDoc | null;
  readonly rules: readonly RateLimitRule[];
};

/**
 * Resolve (or synthesize) the customer context for a playground call.
 * - With customerId: validate it belongs to this org, load it, load its
 *   effective rate-limit rules so the call is metered exactly like real usage.
 * - Without customerId: synthetic playground context — no balance, no rules,
 *   usage_record still written (billed=false) for cost visibility.
 */
function resolvePlaygroundContextEffect(
  orgId: ObjectId,
  customerIdRaw: string | undefined,
) {
  return Effect.gen(function* () {
    if (!customerIdRaw) {
      return {
        customer: null,
        rules: [] as readonly RateLimitRule[],
      } satisfies PlaygroundContext;
    }
    if (!ObjectId.isValid(customerIdRaw)) {
      return yield* Effect.fail(
        billingAppError(
          400,
          "invalid_customer_id",
          "customerId must be a valid ObjectId",
        ),
      );
    }
    const repo = yield* CustomerRepository;
    const customer = yield* repo
      .findById(orgId.toHexString(), customerIdRaw)
      .pipe(
        Effect.mapError(
          (e) =>
            new SystemError({
              code: "system_error",
              message: SAFE_MESSAGES.internal_server_error,
              diagnostic: e instanceof Error ? e.message : String(e),
            }),
        ),
      );
    if (!customer) {
      return yield* Effect.fail(
        billingAppError(
          404,
          "customer_not_found",
          "Customer not found in this org",
        ),
      );
    }
    const rules = yield* getEffectiveRulesOp(customer._id);
    return { customer, rules } satisfies PlaygroundContext;
  });
}

function buildPlaygroundChatRequest(
  body: PlaygroundChatBody,
  stream: boolean,
): ChatRequest {
  return {
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
}

function playgroundCompletionJson(
  result: GenerationCompleteResult,
  modelAlias: string,
  billed: boolean,
) {
  const r = result.response;
  return {
    id: r.id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: modelAlias,
    provider: {
      providerId: result.provider._id.toHexString(),
      upstreamModelId: result.entry.upstreamModelId,
      sdkType: result.provider.sdkType,
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
      ...(r.usage.reasoningTokens !== undefined
        ? { reasoning_tokens: r.usage.reasoningTokens }
        : {}),
      ...(r.usage.cacheReadTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: r.usage.cacheReadTokens } }
        : {}),
    },
    cost: {
      costMinor: result.charges.costMinor,
      priceMinor: result.charges.priceMinor,
      currency: result.charges.currency,
    },
    billed,
  };
}

type PlaygroundPrep = {
  readonly ctx: PlaygroundContext;
  readonly request: ChatRequest;
  readonly model: ModelDoc;
};

playground.post("/chat", sValidator("json", PlaygroundChatBody), async (c) => {
  const orgId = c.get("orgId");
  const body = c.req.valid("json");
  const stream = body.stream ?? false;
  const abortSignal = c.req.raw.signal;

  // Admin playground: validate model only (no balance pre-check). Rate limits
  // come from the selected customer when present (ctx.rules).
  const prep = Effect.gen(function* () {
    const ctx = yield* resolvePlaygroundContextEffect(orgId, body.customerId);
    const model = yield* resolveModelOp(orgId, body.model);
    const request = buildPlaygroundChatRequest(body, stream);
    return { ctx, model, request } satisfies PlaygroundPrep;
  });

  if (!stream) {
    // Wire format is OpenAI-shaped (playground UI reuses that envelope).
    return runOpenAIEffect(
      c,
      Effect.gen(function* () {
        const p = yield* prep;
        const result = yield* completeGeneration({
          orgId,
          model: p.model,
          request: p.request,
          actor: {
            actorKind: "playground" as const,
            customerId: p.ctx.customer?._id ?? null,
            apiKeyId: null,
          },
          rules: p.ctx.rules,
          protocol: "openai",
          reservation: null,
          reservedMinor: 0,
          startedAtMs: Date.now(),
          priceMinorOverride: p.ctx.customer ? undefined : 0,
          signal: abortSignal,
        });
        return playgroundCompletionJson(
          result,
          body.model,
          p.ctx.customer !== null,
        );
      }),
      { operation: "playground.chat" },
    );
  }

  // --- Streaming: Effect prep only; SSE stays at HTTP boundary ---
  const prepExit = await getAppRuntime().runPromiseExit(prep, {
    signal: abortSignal,
  });
  if (Exit.isFailure(prepExit)) {
    const failures = [...Cause.failures(prepExit.cause)];
    return mapExitToHttpResponse(
      prepExit,
      c,
      {
        surface: "openai",
        operation: "playground.chat.streamPrep",
      },
      failures,
    );
  }

  const { ctx, model, request } = prepExit.value;
  const rules = ctx.rules;
  const start = Date.now();
  const actor = {
    actorKind: "playground" as const,
    customerId: ctx.customer?._id ?? null,
    apiKeyId: null,
  };
  const priceMinorOverride = ctx.customer ? undefined : 0;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const id = `playground-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  const session = openStreamGeneration({
    orgId,
    model,
    request,
    actor,
    rules,
    protocol: "openai",
    reservation: null,
    reservedMinor: 0,
    startedAtMs: start,
    priceMinorOverride,
    signal: abortSignal,
  });

  let activeEntry: ModelEntryDoc | null = null;
  let activeProvider: ProviderDoc | null = null;
  const usage = emptyStreamUsage("openai");
  let terminalErrorEmitted = false;
  let clientDisconnected = false;

  const onAbort = () => {
    clientDisconnected = true;
    session.noteInterrupt();
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });

  const encoder = new TextEncoder();

  const body$ = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: unknown) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          clientDisconnected = true;
        }
      };
      const enqueueTerminalError = (code: string, message: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(formatError(code, publicMessageForCode(code, message)));
      };
      const enqueueAppError = (err: unknown) => {
        const classified = isAppError(err)
          ? err
          : classifyGenerationFailure(err);
        if (isAppError(classified) && !terminalErrorEmitted) {
          terminalErrorEmitted = true;
          try {
            controller.enqueue(
              encoder.encode(openAISseTerminalFromAppError(classified)),
            );
          } catch {
            clientDisconnected = true;
          }
        } else if (!terminalErrorEmitted) {
          enqueueTerminalError("upstream_error", SAFE_MESSAGES.upstream_error);
        }
      };
      try {
        enqueue({ id, object: "playground.meta", created, model: body.model });
        for await (const event of session.iterate()) {
          if (clientDisconnected || abortSignal.aborted) {
            session.noteInterrupt();
            break;
          }
          if (event.kind !== "chunk") {
            if (event.kind === "terminal_fail" && !clientDisconnected) {
              enqueueAppError(
                classifyGenerationFailure(event.err, {
                  streamCommitted: event.streamCommitted,
                }),
              );
            }
            continue;
          }
          const { entry, provider, chunk } = event;
          activeEntry = entry;
          activeProvider = provider;
          session.noteChunk(entry.id, chunk);
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
            applyDoneUsage(usage, chunk);
          } else if (chunk.type === "error") {
            enqueueTerminalError(
              "upstream_error",
              chunk.error?.message ?? SAFE_MESSAGES.upstream_error,
            );
          }
        }

        if (clientDisconnected || abortSignal.aborted) {
          // no fabricated body
        } else if (!usage.streamComplete) {
          enqueueTerminalError(
            "stream_truncated",
            "Upstream stream ended without a terminal event; response may be incomplete",
          );
        } else {
          enqueue({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: usage.finishReason }],
          });
          if (usage.promptTokens > 0 || usage.completionTokens > 0) {
            const total =
              usage.reportedTotalTokens !== undefined
                ? usage.reportedTotalTokens
                : usage.promptTokens + usage.completionTokens;
            enqueue({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [],
              usage: {
                prompt_tokens: usage.promptTokens,
                completion_tokens: usage.completionTokens,
                total_tokens: total,
                ...(usage.reasoningTokens > 0 ? { reasoning_tokens: usage.reasoningTokens } : {}),
                ...(usage.cacheReadTokens > 0
                  ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }
                  : {}),
              },
            });
          }
        }

        const finalizeResult = await session.finalize({
          activeEntry,
          activeProvider,
          usage,
          swallowSettleErrors: true,
        });
        if (activeEntry && activeProvider && finalizeResult.action !== "released") {
          const charges = finalizeResult.charges;
          const settled = finalizeResult.action === "settled";
          const billed =
            settled &&
            usage.streamComplete &&
            finalizeResult.hasAuthoritativeUsage &&
            ctx.customer !== null;
          if (charges) {
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
              cost: {
                costMinor: charges.costMinor,
                priceMinor: charges.priceMinor,
                currency: charges.currency,
              },
              billed,
              streamComplete: usage.streamComplete,
            });
          }
        }
        if (usage.streamComplete && !clientDisconnected) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {
            clientDisconnected = true;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          session.noteInterrupt();
        } else if (!clientDisconnected) {
          enqueueAppError(err);
        }
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
        await session.finalize({
          activeEntry,
          activeProvider,
          usage,
          swallowSettleErrors: true,
        });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      clientDisconnected = true;
      session.noteInterrupt();
    },
  });

  return new Response(body$, {
    headers: c.res.headers,
    status: 200,
  });
});

void formatOpenAIErrorBody;

function pickExtras(body: PlaygroundChatBody): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (body.top_k !== undefined) extra.top_k = body.top_k;
  if (body.frequency_penalty !== undefined) extra.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) extra.presence_penalty = body.presence_penalty;
  if (body.seed !== undefined) extra.seed = body.seed;
  return extra;
}

export default playground;
export { playground };
