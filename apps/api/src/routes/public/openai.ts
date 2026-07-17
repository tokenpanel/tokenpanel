import { Hono } from "hono";
import { Cause, Effect, Exit } from "effect";
import type { ModelDoc, ModelEntryDoc, ProviderDoc, RateLimitRule } from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { estimatePromptTokens } from "../../domains/billing/estimate.ts";
import {
  preFlightWorkflow,
  resolveModelOp,
  type BalanceReservation,
} from "../../domains/billing/workflow.ts";
import {
  resolveChatContextEffect,
  actorForChatContext,
  billableCustomerId,
  modelWhitelistForContext,
  V1ChatError,
  type ChatContext,
} from "../../lib/v1-chat-context.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../../providers/index.ts";
import {
  applyDoneUsage,
  classifyGenerationFailure,
  completeGeneration,
  emptyStreamUsage,
  openStreamGeneration,
  type GenerationCompleteResult,
} from "../../domains/providers/generation.ts";
import { listActiveModels } from "../../domains/models/operations.ts";
import {
  mapExitToHttpResponse,
  runOpenAIEffect,
} from "../../http/adapters/boundary.ts";
import { getAppRuntime } from "../../runtime/app-runtime.ts";
import {
  formatOpenAIErrorBody,
  openAISseTerminalFromAppError,
} from "../../http/renderers/openai.ts";
import { isAppError } from "../../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import type { RenderedHttpError } from "../../http/renderers/types.ts";
import {
  OpenAIChatCompletionBody,
  type OpenAIMessage,
  safeParseSchema,
} from "../../http/validation/index.ts";

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
  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (principal && principal.kind === "management") {
    const scopes = principal.managementKey.scopes;
    const allowed = scopes.includes("models:read") || scopes.includes("chat:write");
    if (!allowed) {
      return c.json(formatOpenAIError("missing_scope", "Management key lacks models:read or chat:write"), 403 as 403);
    }
  }
  const whitelist =
    principal && principal.kind === "customer" ? principal.apiKey.modelWhitelist : [];
  return runOpenAIEffect(
    c,
    listActiveModels(orgId.toHexString()).pipe(
      Effect.map((models) => {
        const filtered =
          whitelist.length > 0
            ? models.filter((m) => whitelist.includes(m.aliasId))
            : models;
        return { object: "list" as const, data: filtered.map(toOpenAIModel) };
      }),
    ),
    { operation: "openai.listModels" },
  );
});

/**
 * Management-key-only attribute lives on OpenAIChatCompletionBody.customerEmail
 * (Effect Schema). When present, the call bills + meters the resolved customer
 * inside the key's org. Ignored for customer keys. Stripped before upstream.
 */
export function translateMessage(m: OpenAIMessage): ChatMessage {
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
    toolCalls: m.tool_calls ? [...m.tool_calls] : undefined,
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

/** Preserve historical V1ChatError wire shape (status + formatOpenAIError). */
function mapOpenAIRouteError(err: unknown): RenderedHttpError | null {
  if (err instanceof V1ChatError) {
    return {
      status: err.status,
      body: formatOpenAIError(err.code, err.message),
      headers: {},
    };
  }
  return null;
}

/**
 * Resolve the model + (optional) preflight rules for a chat request.
 *
 * Customer / management_attributed paths run full preFlightWorkflow — model
 * access, rate limits, and balance check — against the billable customer.
 * Org-internal management calls skip balance + rate-limit checks (no customer
 * to bill or meter) but still validate model existence + activeness.
 */
function resolveModelAndRules(params: {
  orgId: import("mongodb").ObjectId;
  ctx: ChatContext;
  aliasId: string;
  estimatedPromptTokens: number;
  maxCompletionTokens?: number;
}) {
  const customerId = billableCustomerId(params.ctx);
  if (customerId === null) {
    return resolveModelOp(params.orgId, params.aliasId).pipe(
      Effect.map((model) => ({
        model,
        rules: [] as readonly RateLimitRule[],
        reservation: null as BalanceReservation | null,
      })),
    );
  }
  return preFlightWorkflow({
    orgId: params.orgId,
    customerId,
    apiKeyModelWhitelist: modelWhitelistForContext(params.ctx),
    aliasId: params.aliasId,
    estimatedPromptTokens: params.estimatedPromptTokens,
    ...(params.maxCompletionTokens !== undefined
      ? { maxCompletionTokens: params.maxCompletionTokens }
      : {}),
  }).pipe(
    Effect.map((r) => ({
      model: r.model,
      rules: r.rules,
      reservation: r.reservation,
    })),
  );
}

function buildOpenAIChatRequest(
  body: typeof OpenAIChatCompletionBody.Type,
  stream: boolean,
): ChatRequest {
  return {
    model: body.model,
    messages: body.messages.map(translateMessage),
    stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens ?? body.max_completion_tokens,
    topP: body.top_p,
    tools: body.tools ? [...body.tools] : undefined,
    toolChoice: body.tool_choice,
    stop: Array.isArray(body.stop)
      ? [...body.stop]
      : body.stop
        ? [body.stop]
        : undefined,
    responseFormat: body.response_format,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
  };
}

function openAICompletionJson(
  result: GenerationCompleteResult,
  modelAlias: string,
) {
  const r = result.response;
  return {
    id: r.id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: modelAlias,
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
      ...(r.usage.reasoningTokens !== undefined
        ? { reasoning_tokens: r.usage.reasoningTokens }
        : {}),
      ...(r.usage.cacheReadTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: r.usage.cacheReadTokens } }
        : {}),
    },
  };
}

type ChatPrep = {
  readonly ctx: ChatContext;
  readonly request: ChatRequest;
  readonly model: ModelDoc;
  readonly rules: readonly RateLimitRule[];
  readonly reservation: BalanceReservation | null;
};

publicOpenAI.post("/v1/chat/completions", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(formatOpenAIError("invalid_request", "invalid body"), 400 as 400);
  }
  const parsed = safeParseSchema(OpenAIChatCompletionBody, raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return c.json(formatOpenAIError("invalid_request", msg || "invalid body"), 400 as 400);
  }
  const body = parsed.data;

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return c.json(formatOpenAIError("unauthorized", "missing principal"), 401 as 401);
  }
  const stream = body.stream ?? false;
  const abortSignal = c.req.raw.signal;

  const prep = Effect.gen(function* () {
    const ctx = yield* resolveChatContextEffect({
      principal,
      customerEmail: body.customerEmail,
    });
    const request = buildOpenAIChatRequest(body, stream);
    const maxCompletion = body.max_tokens ?? body.max_completion_tokens;
    const preflight = yield* resolveModelAndRules({
      orgId,
      ctx,
      aliasId: body.model,
      estimatedPromptTokens: estimatePromptTokens(request.messages),
      ...(maxCompletion !== undefined
        ? { maxCompletionTokens: maxCompletion }
        : {}),
    });
    return {
      ctx,
      request,
      model: preflight.model,
      rules: preflight.rules,
      reservation: preflight.reservation,
    } satisfies ChatPrep;
  });

  // --- Non-streaming: single Effect (context → preflight → complete) ---
  if (!stream) {
    return runOpenAIEffect(
      c,
      Effect.gen(function* () {
        const p = yield* prep;
        const result = yield* completeGeneration({
          orgId,
          model: p.model,
          request: p.request,
          actor: actorForChatContext(p.ctx),
          rules: p.rules,
          protocol: "openai",
          reservation: p.reservation,
          reservedMinor: p.reservation?.reservedMinor ?? 0,
          startedAtMs: Date.now(),
          priceMinorOverride:
            p.ctx.kind === "management_internal" ? 0 : undefined,
          signal: abortSignal,
        });
        return openAICompletionJson(result, body.model);
      }),
      {
        operation: "openai.chatCompletions",
        mapError: (err) => mapOpenAIRouteError(err),
      },
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
        operation: "openai.chatCompletions.streamPrep",
        mapError: (err) => mapOpenAIRouteError(err),
      },
      failures,
    );
  }

  const { ctx, request, model, rules, reservation } = prepExit.value;
  const reservedMinor = reservation?.reservedMinor ?? 0;
  const actor = actorForChatContext(ctx);
  const start = Date.now();
  const priceMinorOverride =
    ctx.kind === "management_internal" ? 0 : undefined;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  const session = openStreamGeneration({
    orgId,
    model,
    request,
    actor,
    rules,
    protocol: "openai",
    reservation,
    reservedMinor,
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
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`),
          );
        } catch {
          clientDisconnected = true;
        }
      };
      const enqueueTerminalError = (code: string, message: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(formatOpenAIError(code, publicMessageForCode(code, message)));
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
          enqueueTerminalError(
            "upstream_error",
            SAFE_MESSAGES.upstream_error,
          );
        }
      };
      try {
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
            if (chunk.delta?.content !== undefined)
              delta.content = chunk.delta.content;
            if (chunk.delta?.reasoning !== undefined)
              delta.reasoning_content = chunk.delta.reasoning;
            if (chunk.delta?.toolCalls !== undefined)
              delta.tool_calls = chunk.delta.toolCalls;
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
          // No fabricated interruption SSE body (13.6).
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
            choices: [
              { index: 0, delta: {}, finish_reason: usage.finishReason },
            ],
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
                ...(usage.reasoningTokens > 0
                  ? { reasoning_tokens: usage.reasoningTokens }
                  : {}),
                ...(usage.cacheReadTokens > 0
                  ? {
                      prompt_tokens_details: {
                        cached_tokens: usage.cacheReadTokens,
                      },
                    }
                  : {}),
              },
            });
          }
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
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        // Pre-commit: release reservation. Post-commit: settle/outbox.
        await session.finalize({
          activeEntry,
          activeProvider,
          usage,
          swallowSettleErrors: true,
        });
      }
    },
    cancel() {
      clientDisconnected = true;
      session.noteInterrupt();
    },
  });

  return new Response(body$, { headers: c.res.headers, status: 200 });
});

void formatOpenAIErrorBody;

export default publicOpenAI;
