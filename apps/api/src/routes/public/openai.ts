import { Hono } from "hono";
import { Cause, Effect, Exit } from "effect";
import type { ModelDoc, ModelEntryDoc, ProviderDoc, RateLimitRule } from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import { estimatePromptTokens } from "../../domains/billing/estimate.ts";
import {
  preFlightWorkflow,
  resolveModelOp,
  type BalanceReservation,
  type LimitReservation,
} from "../../domains/billing/workflow.ts";
import {
  resolveChatContextEffect,
  actorForChatContext,
  billableCustomerId,
  modelWhitelistForContext,
  v1ChatErrorToAppError,
  type ChatContext,
} from "../../lib/v1-chat-context.ts";
import { renderedJson } from "../../http/error-context.ts";
import {
  renderStandardCode,
  renderStandardValidation,
  standardErrorBody,
} from "../../http/renderers/standard.ts";
import {
  standardGenerationError,
  standardStreamError,
} from "../../http/stream-errors.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../../providers/index.ts";
import { toOpenAIFinishReason, toOpenAIToolCallDeltas } from "../../providers/index.ts";
import {
  applyDoneUsage,
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
  OpenAIChatCompletionBody,
  type OpenAIMessage,
  safeParseSchema,
  standardIssues,
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
      return renderedJson(
        c,
        renderStandardCode("openai", "missing_scope", {
          details: { requiredScopes: ["models:read", "chat:write"] },
        }),
      );
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
  let content: string | ContentPart[] | null;
  if (m.content === null || m.content === undefined) {
    // Spec: assistant content is nullable; null is canonical tool-call turns.
    content = null;
  } else if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = m.content.flatMap((part): ContentPart[] => {
      switch (part.type) {
        case "text":
          return [{ type: "text", text: part.text ?? "" }];
        case "image_url":
          return part.image_url
            ? [
                {
                  type: "image_url",
                  imageUrl: {
                    url: part.image_url.url,
                    ...(part.image_url.detail !== undefined ? { detail: part.image_url.detail } : {}),
                  },
                },
              ]
            : [];
        case "input_audio":
          return part.input_audio
            ? [
                {
                  type: "input_audio",
                  inputData: { data: part.input_audio.data, format: part.input_audio.format },
                },
              ]
            : [];
        case "file":
          return part.file
            ? [
                {
                  type: "file",
                  file: {
                    ...(part.file.file_id !== undefined ? { fileId: part.file.file_id } : {}),
                    ...(part.file.file_data !== undefined ? { fileData: part.file.file_data } : {}),
                    ...(part.file.filename !== undefined ? { filename: part.file.filename } : {}),
                  },
                },
              ]
            : [];
        default:
          return [];
      }
    });
  }
  return {
    role: m.role,
    content,
    name: m.name,
    refusal: m.refusal,
    audio: m.audio,
    toolCallId: m.tool_call_id,
    toolCalls: m.tool_calls ? [...m.tool_calls] : undefined,
  };
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
        limitReservation: null as LimitReservation | null,
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
      limitReservation: r.limitReservation,
    })),
  );
}

export function buildOpenAIChatRequest(
  body: typeof OpenAIChatCompletionBody.Type,
  stream: boolean,
): ChatRequest {
  return {
    model: body.model,
    messages: body.messages.map(translateMessage),
    stream,
    temperature: body.temperature ?? undefined,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? undefined,
    topP: body.top_p ?? undefined,
    tools: body.tools ? [...body.tools] : undefined,
    toolChoice: body.tool_choice,
    stop: Array.isArray(body.stop)
      ? [...body.stop]
      : body.stop
        ? [body.stop]
        : undefined,
    responseFormat: body.response_format,
    reasoning: body.reasoning_effort ? { effort: body.reasoning_effort } : undefined,
    extra: pickOpenAIExtras(body),
  };
}

/**
 * Forward spec params the shared ChatRequest does not model. Adapters merge
 * `extra` into the upstream body (reasoning models still filter penalties).
 */
function pickOpenAIExtras(
  body: typeof OpenAIChatCompletionBody.Type,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (body.n !== undefined) extra.n = body.n;
  if (body.frequency_penalty !== undefined) extra.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) extra.presence_penalty = body.presence_penalty;
  if (body.logit_bias !== undefined) extra.logit_bias = body.logit_bias;
  if (body.logprobs !== undefined) extra.logprobs = body.logprobs;
  if (body.top_logprobs !== undefined) extra.top_logprobs = body.top_logprobs;
  if (body.seed !== undefined) extra.seed = body.seed;
  if (body.parallel_tool_calls !== undefined) extra.parallel_tool_calls = body.parallel_tool_calls;
  if (body.store !== undefined) extra.store = body.store;
  if (body.metadata !== undefined) extra.metadata = body.metadata;
  if (body.user !== undefined) extra.user = body.user;
  if (body.verbosity !== undefined) extra.verbosity = body.verbosity;
  if (body.modalities !== undefined) extra.modalities = body.modalities;
  if (body.web_search_options !== undefined) extra.web_search_options = body.web_search_options;
  if (body.prediction !== undefined) extra.prediction = body.prediction;
  if (body.audio !== undefined) extra.audio = body.audio;
  if (body.moderation !== undefined) extra.moderation = body.moderation;
  if (body.service_tier !== undefined) extra.service_tier = body.service_tier;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

export function openAICompletionJson(
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
        // Spec: content is `string | null`; null on tool-call-only turns.
        content: ch.message.content ?? null,
        refusal: ch.message.refusal ?? null,
        ...(ch.message.toolCalls !== undefined ? { tool_calls: ch.message.toolCalls } : {}),
      },
      finish_reason: toOpenAIFinishReason(ch.finishReason),
    })),
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.totalTokens,
      ...(r.usage.reasoningTokens !== undefined
        ? {
            completion_tokens_details: { reasoning_tokens: r.usage.reasoningTokens },
          }
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
  readonly limitReservation: LimitReservation | null;
};

publicOpenAI.post("/v1/chat/completions", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return renderedJson(
      c,
      renderStandardCode("openai", "validation_error", {
        message: "The request body is not valid JSON.",
      }),
    );
  }
  const parsed = safeParseSchema(OpenAIChatCompletionBody, raw);
  if (!parsed.success) {
    return renderedJson(
      c,
      renderStandardValidation("openai", standardIssues(parsed.error.issues)),
    );
  }
  const body = parsed.data;

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return renderedJson(c, renderStandardCode("openai", "unauthorized"));
  }
  const stream = body.stream ?? false;
  const abortSignal = c.req.raw.signal;

  const prep = Effect.gen(function* () {
    const ctx = yield* resolveChatContextEffect({
      principal,
      customerEmail: body.customerEmail,
    });
    const request = buildOpenAIChatRequest(body, stream);
    const maxCompletion = body.max_tokens ?? body.max_completion_tokens ?? undefined;
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
      limitReservation: preflight.limitReservation,
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
          limitReservation: p.limitReservation,
          reservedMicros: p.reservation?.reservedMicros ?? 0,
          startedAtMs: Date.now(),
          priceMicrosOverride:
            p.ctx.kind === "management_internal" ? 0 : undefined,
          signal: abortSignal,
        });
        return openAICompletionJson(result, body.model);
      }),
      {
        operation: "openai.chatCompletions",
        toAppError: v1ChatErrorToAppError,
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
        toAppError: v1ChatErrorToAppError,
      },
      failures,
    );
  }

  const { ctx, request, model, rules, reservation, limitReservation } =
    prepExit.value;
  const reservedMicros = reservation?.reservedMicros ?? 0;
  const actor = actorForChatContext(ctx);
  const start = Date.now();
  const priceMicrosOverride =
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
    limitReservation,
    reservedMicros,
    startedAtMs: start,
    priceMicrosOverride,
    signal: abortSignal,
  });

  let activeEntry: ModelEntryDoc | null = null;
  let activeProvider: ProviderDoc | null = null;
  const usage = emptyStreamUsage("openai");
  let terminalErrorEmitted = false;
  let clientDisconnected = false;
  let roleSent = false;

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
      // Terminal error event: `data: {"error":{…}}`, which OpenAI SDKs raise
      // as APIError. TokenPanel text only; provider output never reaches here.
      const enqueueTerminalError = (code: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(standardErrorBody("openai", standardStreamError(code)));
      };
      const enqueueAppError = (err: unknown, streamCommitted = false) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(
          standardErrorBody("openai", standardGenerationError(err, { streamCommitted })),
        );
      };
      // SSE heartbeat: keeps the connection alive through proxies (Cloudflare,
      // Caddy, nginx) during upstream silence (LLM thinking, slow generation).
      // Comment lines are ignored by all conforming SSE clients.
      const HEARTBEAT_INTERVAL_MS = 15_000;
      const heartbeat = setInterval(() => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clientDisconnected = true;
        }
      }, HEARTBEAT_INTERVAL_MS);
      try {
        for await (const event of session.iterate()) {
          if (clientDisconnected || abortSignal.aborted) {
            session.noteInterrupt();
            break;
          }
          if (event.kind !== "chunk") {
            if (event.kind === "terminal_fail" && !clientDisconnected) {
              enqueueAppError(event.err, event.streamCommitted);
            }
            continue;
          }
          const { entry, provider, chunk } = event;
          activeEntry = entry;
          activeProvider = provider;
          session.noteChunk(entry.id, chunk);
          if (chunk.type === "delta") {
            const delta: Record<string, unknown> = {};
            if (!roleSent) {
              delta.role = "assistant";
              roleSent = true;
            }
            if (chunk.delta?.content !== undefined)
              delta.content = chunk.delta.content;
            if (chunk.delta?.reasoning !== undefined)
              delta.reasoning_content = chunk.delta.reasoning;
            if (chunk.delta?.toolCalls !== undefined) {
              delta.tool_calls = toOpenAIToolCallDeltas(
                chunk.delta.toolCalls as Record<string, unknown>[],
              );
            }
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
            enqueueTerminalError(chunk.error?.code ?? "upstream_error");
          }
        }
        if (clientDisconnected || abortSignal.aborted) {
          // No fabricated interruption SSE body (13.6).
        } else if (!usage.streamComplete) {
          enqueueTerminalError("stream_truncated");
        } else {
          enqueue({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [
              { index: 0, delta: {}, finish_reason: toOpenAIFinishReason(usage.finishReason) },
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
                  ? {
                      completion_tokens_details: {
                        reasoning_tokens: usage.reasoningTokens,
                      },
                    }
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
        clearInterval(heartbeat);
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


export default publicOpenAI;
