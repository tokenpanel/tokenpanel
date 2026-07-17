import { Hono } from "hono";
import { Cause, Effect, Exit } from "effect";
import type { ObjectId } from "mongodb";
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
import type { ChatRequest, ChatMessage } from "../../providers/index.ts";
import {
  applyDoneUsage,
  classifyGenerationFailure,
  completeGeneration,
  emptyStreamUsage,
  openStreamGeneration,
  type GenerationCompleteResult,
} from "../../domains/providers/generation.ts";
import {
  formatAnthropicErrorBody,
  anthropicSseTerminalFromAppError,
} from "../../http/renderers/anthropic.ts";
import { isAppError } from "../../errors/families.ts";
import { publicMessageForCode, SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import {
  mapExitToHttpResponse,
  runAnthropicEffect,
} from "../../http/adapters/boundary.ts";
import { getAppRuntime } from "../../runtime/app-runtime.ts";
import type { RenderedHttpError } from "../../http/renderers/types.ts";
import {
  AnthropicMessagesBody,
  type AnthropicMessage,
  safeParseSchema,
} from "../../http/validation/index.ts";

const publicAnthropic = new Hono<{ Variables: PublicAuthVariables }>();
// Auth is mounted once on the parent app for /v1/* (index.ts) so openai +
// anthropic handlers do not double-authenticate.

/**
 * Management-key-only attribute on AnthropicMessagesBody.customerEmail.
 * Ignored for customer keys; stripped before upstream.
 */
export function translateAnthropicMessage(m: AnthropicMessage): ChatMessage {
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

/** Preserve historical V1ChatError → Anthropic envelope mapping. */
function mapAnthropicRouteError(err: unknown): RenderedHttpError | null {
  if (err instanceof V1ChatError) {
    const type =
      err.code === "missing_scope"
        ? "permission_error"
        : err.code === "customer_not_found"
          ? "not_found_error"
          : "invalid_request_error";
    return {
      status: err.status,
      body: anthropicError(type, err.message),
      headers: {},
    };
  }
  return null;
}

/**
 * Resolve model + rules via domain Effect preFlightWorkflow.
 * Internal management calls skip balance/limit checks but still validate model.
 */
function resolveModelAndRules(params: {
  orgId: ObjectId;
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

function buildAnthropicChatRequest(
  body: typeof AnthropicMessagesBody.Type,
  stream: boolean,
): ChatRequest {
  const messages: ChatMessage[] = body.messages.map(translateAnthropicMessage);
  if (body.system) {
    const sysText =
      typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    messages.unshift({ role: "system", content: sysText });
  }
  return {
    model: body.model,
    messages,
    stream,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    tools: body.tools ? [...body.tools] : undefined,
    toolChoice: body.tool_choice,
    stop: body.stop_sequences ? [...body.stop_sequences] : undefined,
  };
}

function anthropicMessageJson(
  result: GenerationCompleteResult,
  modelAlias: string,
) {
  const r = result.response;
  const choice = r.choices[0];
  const textContent =
    typeof choice?.message.content === "string" ? choice.message.content : "";
  const contentBlocks: unknown[] = [{ type: "text", text: textContent }];
  const toolCalls = choice?.message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const t = tc as {
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      contentBlocks.push({
        type: "tool_use",
        id: t.id ?? "",
        name: t.function?.name ?? "",
        input: (() => {
          try {
            return JSON.parse(t.function?.arguments ?? "{}");
          } catch {
            return {};
          }
        })(),
      });
    }
  }

  return {
    id: r.id,
    type: "message" as const,
    role: "assistant" as const,
    model: modelAlias,
    content: contentBlocks,
    stop_reason: choice?.finishReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: r.usage.promptTokens,
      output_tokens: r.usage.completionTokens,
      ...(r.usage.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: r.usage.cacheReadTokens }
        : {}),
      ...(r.usage.cacheWriteTokens !== undefined
        ? { cache_creation_input_tokens: r.usage.cacheWriteTokens }
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

publicAnthropic.post("/v1/messages", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(anthropicError("invalid_request_error", "invalid body"), 400 as 400);
  }
  const parsed = safeParseSchema(AnthropicMessagesBody, raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return c.json(
      anthropicError("invalid_request_error", msg || "invalid body"),
      400 as 400,
    );
  }
  const body = parsed.data;

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return c.json(anthropicError("authentication_error", "missing principal"), 401 as 401);
  }
  const stream = body.stream ?? false;
  const abortSignal = c.req.raw.signal;

  const prep = Effect.gen(function* () {
    const ctx = yield* resolveChatContextEffect({
      principal,
      customerEmail: body.customerEmail,
    });
    const request = buildAnthropicChatRequest(body, stream);
    const preflight = yield* resolveModelAndRules({
      orgId,
      ctx,
      aliasId: body.model,
      estimatedPromptTokens: estimatePromptTokens(request.messages),
      maxCompletionTokens: body.max_tokens,
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
    return runAnthropicEffect(
      c,
      Effect.gen(function* () {
        const p = yield* prep;
        const result = yield* completeGeneration({
          orgId,
          model: p.model,
          request: p.request,
          actor: actorForChatContext(p.ctx),
          rules: p.rules,
          protocol: "anthropic",
          reservation: p.reservation,
          reservedMinor: p.reservation?.reservedMinor ?? 0,
          startedAtMs: Date.now(),
          priceMinorOverride:
            p.ctx.kind === "management_internal" ? 0 : undefined,
          signal: abortSignal,
        });
        return anthropicMessageJson(result, body.model);
      }),
      {
        operation: "anthropic.messages",
        mapError: (err) => mapAnthropicRouteError(err),
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
        surface: "anthropic",
        operation: "anthropic.messages.streamPrep",
        mapError: (err) => mapAnthropicRouteError(err),
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

  const messageId = `msg_${Date.now().toString(36)}`;
  const session = openStreamGeneration({
    orgId,
    model,
    request,
    actor,
    rules,
    protocol: "anthropic",
    reservation,
    reservedMinor,
    startedAtMs: start,
    priceMinorOverride,
    signal: abortSignal,
  });

  let activeEntry: ModelEntryDoc | null = null;
  let activeProvider: ProviderDoc | null = null;
  const usage = emptyStreamUsage("anthropic");
  let blockStarted = false;
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
      const enqueue = (event: string, obj: unknown) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
        } catch {
          clientDisconnected = true;
        }
      };
      const closeOpenBlock = () => {
        if (!blockStarted) return;
        enqueue("content_block_stop", { type: "content_block_stop", index: 0 });
        blockStarted = false;
      };
      const enqueueTerminalError = (type: string, message: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        closeOpenBlock();
        enqueue("error", {
          type: "error",
          error: { type, message: publicMessageForCode(type, message) },
        });
      };
      const enqueueAppError = (err: unknown) => {
        const classified = isAppError(err)
          ? err
          : classifyGenerationFailure(err);
        if (isAppError(classified) && !terminalErrorEmitted) {
          terminalErrorEmitted = true;
          closeOpenBlock();
          try {
            controller.enqueue(
              encoder.encode(anthropicSseTerminalFromAppError(classified)),
            );
          } catch {
            clientDisconnected = true;
          }
        } else if (!terminalErrorEmitted) {
          enqueueTerminalError("upstream_error", SAFE_MESSAGES.upstream_error);
        }
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
            applyDoneUsage(usage, chunk);
          } else if (chunk.type === "error") {
            enqueueTerminalError(
              "upstream_error",
              chunk.error?.message ?? SAFE_MESSAGES.upstream_error,
            );
          }
        }

        if (clientDisconnected || abortSignal.aborted) {
          // No fabricated interruption body (13.6).
        } else if (!usage.streamComplete) {
          enqueueTerminalError(
            "stream_truncated",
            "Upstream stream ended without message_stop; response may be incomplete",
          );
        } else {
          closeOpenBlock();
          enqueue("message_delta", {
            type: "message_delta",
            delta: { stop_reason: usage.finishReason, stop_sequence: null },
            usage: { output_tokens: usage.completionTokens },
          });
          enqueue("message_stop", { type: "message_stop" });
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

void formatAnthropicErrorBody;

export default publicAnthropic;
