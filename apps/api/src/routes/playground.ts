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
import {
  requireAuth,
  requirePermission,
  type AuthVariables,
} from "../middleware/auth.ts";
import { billingAppError } from "../lib/billing-errors.ts";
import { resolveModelOp } from "../domains/billing/workflow.ts";
import { getEffectiveRulesOp } from "../domains/limits/operations.ts";
import type { ChatRequest, ChatMessage, ContentPart } from "../providers/index.ts";
import { toOpenAIFinishReason, toOpenAIToolCallDeltas } from "../providers/index.ts";
import {
  applyDoneUsage,
  completeGeneration,
  emptyStreamUsage,
  openStreamGeneration,
  type GenerationCompleteResult,
} from "../domains/providers/generation.ts";
import { CustomerRepository } from "../domains/ports/customer-repository.ts";
import { standardErrorBody } from "../http/renderers/standard.ts";
import {
  standardGenerationError,
  standardStreamError,
} from "../http/stream-errors.ts";
import { SystemError } from "../errors/families.ts";
import { SAFE_MESSAGES } from "../errors/safe-messages.ts";
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

// Playground calls upstream providers with the org's decrypted API keys.
// Gated by playground:write (admins hold all panel permissions).
playground.use("*", requireAuth, requirePermission("playground:write"));

type PlaygroundMessage = PlaygroundChatBody["messages"][number];

function translateMessage(m: PlaygroundMessage): ChatMessage {
  let content: string | ContentPart[] | null;
  if (m.content === null || m.content === undefined) {
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
    toolCallId: m.tool_call_id,
    toolCalls: m.tool_calls ? [...m.tool_calls] : undefined,
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
        content: ch.message.content ?? null,
        refusal: ch.message.refusal ?? null,
        reasoning_content: ch.message.reasoning,
        ...(ch.message.toolCalls !== undefined ? { tool_calls: ch.message.toolCalls } : {}),
      },
      finish_reason: toOpenAIFinishReason(ch.finishReason),
    })),
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.totalTokens,
      ...(r.usage.reasoningTokens !== undefined
        ? { completion_tokens_details: { reasoning_tokens: r.usage.reasoningTokens } }
        : {}),
      ...(r.usage.cacheReadTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: r.usage.cacheReadTokens } }
        : {}),
    },
    cost: {
      costMicros: result.charges.costMicros,
      priceMicros: result.charges.priceMicros,
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
          reservedMicros: 0,
          startedAtMs: Date.now(),
          priceMicrosOverride: p.ctx.customer ? undefined : 0,
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
  const priceMicrosOverride = ctx.customer ? undefined : 0;

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
    reservedMicros: 0,
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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          clientDisconnected = true;
        }
      };
      // Admin surface: standard OpenAI-shaped events plus upstream debug
      // detail (classified message, upstream status and redacted body).
      const enqueueTerminalError = (code: string) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(standardErrorBody("openai", standardStreamError(code)));
      };
      const enqueueAppError = (err: unknown, streamCommitted = false) => {
        if (terminalErrorEmitted || clientDisconnected) return;
        terminalErrorEmitted = true;
        enqueue(
          standardErrorBody(
            "openai",
            standardGenerationError(err, { streamCommitted, debug: true }),
          ),
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
        enqueue({ id, object: "playground.meta", created, model: body.model });
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
            if (chunk.delta?.content !== undefined) delta.content = chunk.delta.content;
            if (chunk.delta?.reasoning !== undefined) delta.reasoning_content = chunk.delta.reasoning;
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
          // no fabricated body
        } else if (!usage.streamComplete) {
          enqueueTerminalError("stream_truncated");
        } else {
          enqueue({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: toOpenAIFinishReason(usage.finishReason) }],
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
                  ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
                  : {}),
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
                costMicros: charges.costMicros,
                priceMicros: charges.priceMicros,
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
        clearInterval(heartbeat);
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
