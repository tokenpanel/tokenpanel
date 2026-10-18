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
import {
  toAnthropicStopReason,
  anthropicToolInstructions,
  AnthropicBlockStream,
} from "../../providers/index.ts";
import {
  applyDoneUsage,
  completeGeneration,
  emptyStreamUsage,
  openStreamGeneration,
  type GenerationCompleteResult,
} from "../../domains/providers/generation.ts";
import {
  mapExitToHttpResponse,
  runAnthropicEffect,
} from "../../http/adapters/boundary.ts";
import { getAppRuntime } from "../../runtime/app-runtime.ts";
import {
  AnthropicMessagesBody,
  type AnthropicMessage,
  safeParseSchema,
  standardIssues,
} from "../../http/validation/index.ts";

const publicAnthropic = new Hono<{ Variables: PublicAuthVariables }>();
// Auth is mounted once on the parent app for /v1/* (index.ts) so openai +
// anthropic handlers do not double-authenticate.

/**
 * Management-key-only attribute on AnthropicMessagesBody.customerEmail.
 * Ignored for customer keys; stripped before upstream.
 */
export function translateAnthropicMessage(m: AnthropicMessage): ChatMessage {
  let content: string | ContentPart[];
  if (typeof m.content === "string") {
    content = m.content;
  } else {
    content = m.content.map((block): ContentPart => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text ?? "" };
        case "image": {
          const src = block.source;
          if (src?.type === "url" && src.url !== undefined) {
            return { type: "image_url", imageUrl: { url: src.url } };
          }
          if (src?.type === "base64" && src.media_type !== undefined && src.data !== undefined) {
            return {
              type: "image_url",
              imageUrl: { url: `data:${src.media_type};base64,${src.data}` },
            };
          }
          return { type: "raw", block: { ...block } };
        }
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id ?? "",
            name: block.name ?? "",
            input: block.input ?? {},
          };
        case "tool_result":
          return {
            type: "tool_result",
            toolUseId: block.tool_use_id ?? "",
            ...(block.content !== undefined ? { content: block.content } : {}),
            ...(block.is_error !== undefined ? { isError: block.is_error } : {}),
          };
        default:
          // thinking / redacted_thinking / document / server-tool blocks:
          // keep verbatim so the Anthropic adapter replays them faithfully.
          return { type: "raw", block: { ...block } };
      }
    });
  }
  return { role: m.role, content };
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

function systemToText(system: string | readonly unknown[]): string {
  if (typeof system === "string") return system;
  const parts: string[] = [];
  for (const item of system) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item && typeof item === "object") {
      const b = item as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n\n");
}

export function buildAnthropicChatRequest(
  body: typeof AnthropicMessagesBody.Type,
  stream: boolean,
): ChatRequest {
  const messages: ChatMessage[] = body.messages.map(translateAnthropicMessage);
  return {
    model: body.model,
    messages,
    // Structured carrier: text for estimation / OpenAI-shaped upstreams,
    // original blocks (cache_control breakpoints intact) for Anthropic
    // upstreams — prompt caching only hits when breakpoints survive.
    ...(body.system
      ? {
          system: {
            text: systemToText(body.system),
            ...(typeof body.system === "string" ? {} : { blocks: [...body.system] }),
          },
        }
      : {}),
    stream,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    tools: body.tools ? [...body.tools] : undefined,
    toolChoice: body.tool_choice,
    stop: body.stop_sequences ? [...body.stop_sequences] : undefined,
    extra: pickAnthropicExtras(body),
  };
}

/**
 * Effective completion window for preflight reservation. When extended
 * thinking is enabled the upstream window is `max_tokens` OR
 * `budget_tokens + 4096` (the adapter's inflation margin), whichever is
 * larger. Reserving against the effective window prevents a client from
 * holding a tiny balance while the upstream generates a large reasoning
 * budget — the reservation must cover what can actually be billed.
 */
export function effectiveAnthropicMaxTokens(
  body: typeof AnthropicMessagesBody.Type,
): number {
  const thinking = body.thinking;
  if (thinking && thinking.type === "enabled") {
    return Math.max(body.max_tokens, Math.ceil(thinking.budget_tokens) + 4096);
  }
  return body.max_tokens;
}

/** Forward Anthropic params the shared ChatRequest does not model. */
function pickAnthropicExtras(
  body: typeof AnthropicMessagesBody.Type,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (body.top_k !== undefined) extra.top_k = body.top_k;
  if (body.thinking !== undefined) extra.thinking = body.thinking;
  if (body.metadata !== undefined) extra.metadata = body.metadata;
  if (body.service_tier !== undefined) extra.service_tier = body.service_tier;
  if (body.container !== undefined) extra.container = body.container;
  if (body.mcp_servers !== undefined) extra.mcp_servers = body.mcp_servers;
  if (body.betas !== undefined) extra.betas = body.betas;
  return Object.keys(extra).length > 0 ? extra : undefined;
}

export function anthropicMessageJson(
  result: GenerationCompleteResult,
  modelAlias: string,
) {
  const r = result.response;
  const choice = r.choices[0];
  const contentBlocks: unknown[] = [];
  const text = choice?.message.content;
  if (typeof text === "string" && text.length > 0) {
    contentBlocks.push({ type: "text", text });
  }
  const toolCalls = choice?.message.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const t = tc as {
        id?: string;
        function?: { name?: string; arguments?: string };
      };
      let input: unknown = {};
      try {
        input = JSON.parse(t.function?.arguments ?? "{}");
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: "tool_use",
        id: t.id ?? "",
        name: t.function?.name ?? "",
        input,
      });
    }
  }
  if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

  return {
    id: r.id,
    type: "message" as const,
    role: "assistant" as const,
    model: modelAlias,
    content: contentBlocks,
    stop_reason: toAnthropicStopReason(choice?.finishReason),
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
  readonly limitReservation: LimitReservation | null;
};

publicAnthropic.post("/v1/messages", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return renderedJson(
      c,
      renderStandardCode("anthropic", "validation_error", {
        message: "The request body is not valid JSON.",
      }),
    );
  }
  const parsed = safeParseSchema(AnthropicMessagesBody, raw);
  if (!parsed.success) {
    return renderedJson(
      c,
      renderStandardValidation("anthropic", standardIssues(parsed.error.issues)),
    );
  }
  const body = parsed.data;

  const orgId = c.get("orgId");
  const principal = c.get("principal");
  if (!principal) {
    return renderedJson(c, renderStandardCode("anthropic", "unauthorized"));
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
      estimatedPromptTokens: estimatePromptTokens(request.messages, request.system?.text),
      maxCompletionTokens: effectiveAnthropicMaxTokens(body),
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
          limitReservation: p.limitReservation,
          reservedMicros: p.reservation?.reservedMicros ?? 0,
          startedAtMs: Date.now(),
          priceMicrosOverride:
            p.ctx.kind === "management_internal" ? 0 : undefined,
          signal: abortSignal,
        });
        return anthropicMessageJson(result, body.model);
      }),
      {
        operation: "anthropic.messages",
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
        surface: "anthropic",
        operation: "anthropic.messages.streamPrep",
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

  const messageId = `msg_${Date.now().toString(36)}`;
  const session = openStreamGeneration({
    orgId,
    model,
    request,
    actor,
    rules,
    protocol: "anthropic",
    reservation,
    limitReservation,
    reservedMicros,
    startedAtMs: start,
    priceMicrosOverride,
    signal: abortSignal,
  });

  let activeEntry: ModelEntryDoc | null = null;
  let activeProvider: ProviderDoc | null = null;
  const usage = emptyStreamUsage("anthropic");
  const blocks = new AnthropicBlockStream();
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
        const idx = blocks.closeOpen();
        if (idx !== null) {
          enqueue("content_block_stop", { type: "content_block_stop", index: idx });
        }
      };
      const emitBlockStart = (
        index: number,
        kind: "text" | "thinking" | "tool_use",
        tool?: { id: string; name: string },
      ) => {
        const contentBlock =
          kind === "tool_use"
            ? { type: "tool_use", id: tool?.id ?? "", name: tool?.name ?? "", input: {} }
            : kind === "thinking"
              ? { type: "thinking", thinking: "", signature: "" }
              : { type: "text", text: "" };
        enqueue("content_block_start", {
          type: "content_block_start",
          index,
          content_block: contentBlock,
        });
      };
      const ensureBlock = (kind: "text" | "thinking") => {
        const t = blocks.transition(kind);
        for (const idx of t.close) {
          enqueue("content_block_stop", { type: "content_block_stop", index: idx });
        }
        for (const s of t.start) emitBlockStart(s.index, s.kind);
        return t.index;
      };
      // Terminal `event: error` (Anthropic streaming contract). TokenPanel
      // text only; provider output never reaches here.
      const enqueueTerminalError = (code: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        closeOpenBlock();
        enqueue("error", standardErrorBody("anthropic", standardStreamError(code)));
      };
      const enqueueAppError = (err: unknown, streamCommitted = false) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        closeOpenBlock();
        enqueue(
          "error",
          standardErrorBody("anthropic", standardGenerationError(err, { streamCommitted })),
        );
      };
      // SSE heartbeat: keeps the connection alive through proxies during
      // upstream silence. Comment lines are ignored by all SSE clients.
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
        // Blocks open lazily on first delta so tool-only responses never
        // emit a phantom empty text block.

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
            if (chunk.delta?.content !== undefined) {
              const index = ensureBlock("text");
              enqueue("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: chunk.delta.content },
              });
            }
            if (chunk.delta?.reasoning !== undefined) {
              const index = ensureBlock("thinking");
              enqueue("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: chunk.delta.reasoning },
              });
            }
            if (chunk.delta?.toolCalls !== undefined) {
              const instr = anthropicToolInstructions(
                blocks,
                chunk.delta.toolCalls as Record<string, unknown>[],
              );
              for (const idx of instr.close) {
                enqueue("content_block_stop", { type: "content_block_stop", index: idx });
              }
              for (const s of instr.start) {
                emitBlockStart(s.index, "tool_use", { id: s.id, name: s.name });
              }
              for (const j of instr.json) {
                enqueue("content_block_delta", {
                  type: "content_block_delta",
                  index: j.index,
                  delta: { type: "input_json_delta", partial_json: j.partial },
                });
              }
            }
          } else if (chunk.type === "done") {
            applyDoneUsage(usage, chunk);
          } else if (chunk.type === "error") {
            enqueueTerminalError(chunk.error?.code ?? "upstream_error");
          }
        }

        if (clientDisconnected || abortSignal.aborted) {
          // No fabricated interruption body (13.6).
        } else if (!usage.streamComplete) {
          enqueueTerminalError("stream_truncated");
        } else {
          closeOpenBlock();
          enqueue("message_delta", {
            type: "message_delta",
            delta: { stop_reason: toAnthropicStopReason(usage.finishReason), stop_sequence: null },
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
        clearInterval(heartbeat);
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


export default publicAnthropic;
