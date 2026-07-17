import { Effect } from "effect";
import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  DiscoveredModel,
  ProviderAdapter,
  StreamChunk,
} from "./types.ts";
import {
  parseOpenAIProviderUsage,
  ZERO_USAGE,
  type ProviderUsage,
} from "./provider-usage.ts";
import {
  makeProviderError,
  providerHttpError,
  publicProviderErrorMessage,
} from "./provider-errors.ts";
import { providerHttpRequest } from "../infrastructure/provider-http/scoped-fetch.ts";
import { httpFailureToProviderError } from "./map-http-error.ts";

import {
  OPENAI_DEFAULT_CONTEXT_TOKENS,
  OPENAI_SSE_DONE_PAYLOAD,
} from "./openai-protocol.ts";

/** Unknown context is omitted (not a positive sentinel). Historical name kept for grep. */
const OPENAI_DEFAULT_CONTEXT = OPENAI_DEFAULT_CONTEXT_TOKENS;

type OpenAiModel = {
  id: string;
  context_window?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
  object?: string;
  owned_by?: string;
  [k: string]: unknown;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function authHeaders(ctx: AdapterContext): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
    "Content-Type": "application/json",
  };
  if (ctx.providerOrg) h["OpenAI-Organization"] = ctx.providerOrg;
  if (ctx.headers) Object.assign(h, ctx.headers);
  return h;
}

export function joinUrl(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  if (!base.endsWith("/") && !path.startsWith("/")) return base + "/" + path;
  return base + path;
}

function toOpenAiMessages(req: ChatRequest): unknown[] {
  return req.messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

export function buildChatBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req),
    stream,
  };

  const hasReasoning = req.reasoning !== undefined && typeof req.reasoning === "object" && req.reasoning?.effort;

  if (hasReasoning) {
    // OpenAI reasoning models (o-series, gpt-5) reject temperature, top_p,
    // frequency_penalty, presence_penalty and require max_completion_tokens
    // instead of max_tokens. Strip all incompatible params.
    body.reasoning_effort = (req.reasoning as { effort: string }).effort;
    if (req.maxTokens !== undefined) body.max_completion_tokens = req.maxTokens;
  } else {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.topP !== undefined) body.top_p = req.topP;
  }

  if (req.tools !== undefined) body.tools = req.tools;
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
  if (req.stop !== undefined) body.stop = req.stop;
  if (req.responseFormat !== undefined) body.response_format = req.responseFormat;
  if (stream) body.stream_options = { include_usage: true };

  if (req.extra) {
    if (hasReasoning) {
      // Filter out params unsupported by reasoning models
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.extra)) {
        if (k === "frequency_penalty" || k === "presence_penalty") continue;
        filtered[k] = v;
      }
      Object.assign(body, filtered);
    } else {
      Object.assign(body, req.extra);
    }
  }
  return body;
}

/**
 * Parse OpenAI usage into TokenUsage.
 * Prefer parseOpenAIUsageResult for settlement — missing usage is explicit.
 * This wrapper maps missing → zeros for stream/chunk compatibility; settlement
 * paths must call parseOpenAIUsageResult and refuse free settle.
 */
export function parseUsage(u: unknown): ChatResponse["usage"] {
  const r = parseOpenAIProviderUsage(u);
  if (r.status === "missing") return { ...ZERO_USAGE };
  return r.usage;
}

export function parseOpenAIUsageResult(u: unknown): ProviderUsage {
  return parseOpenAIProviderUsage(u);
}

export function assembleChoice(raw: unknown, index: number): ChatResponse["choices"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const msgRaw = r.message as Record<string, unknown> | undefined;
  if (!msgRaw) return null;
  const role = (str(msgRaw.role) ?? "assistant") as ChatMessage["role"];
  let content = "";
  if (typeof msgRaw.content === "string") content = msgRaw.content;
  const toolCalls = msgRaw.tool_calls as unknown[] | undefined;
  const message: ChatMessage = { role, content };
  if (toolCalls) message.toolCalls = toolCalls;
  if (msgRaw.refusal !== undefined) message.content = String(msgRaw.refusal ?? "");
  const reasoningContent =
    str(msgRaw.reasoning_content) ??
    str(typeof msgRaw.reasoning === "string" ? msgRaw.reasoning : undefined) ??
    str((msgRaw.reasoning as Record<string, unknown> | undefined)?.text);
  if (reasoningContent) message.reasoning = reasoningContent;
  return {
    index,
    message,
    finishReason: str(r.finish_reason) ?? "stop",
  };
}

export function createOpenAICompatibleAdapter(): ProviderAdapter {
  return {
    sdkType: "openai-compatible",

    listModels(ctx) {
      return Effect.gen(function* () {
        const res = yield* providerHttpRequest({
          url: joinUrl(ctx.baseUrl, "/models"),
          method: "GET",
          headers: authHeaders(ctx),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          label: "openai listModels",
          operation: "listModels",
        }).pipe(Effect.mapError(httpFailureToProviderError));

        if (res.status < 200 || res.status >= 300) {
          return yield* Effect.fail(
            providerHttpError(
              res.status,
              res.diagnostic,
              "request",
              "openai listModels",
            ),
          );
        }

        const json = yield* Effect.try({
          try: () => JSON.parse(res.bodyText) as { data?: OpenAiModel[] },
          catch: () =>
            makeProviderError({
              message: publicProviderErrorMessage("openai listModels"),
              category: "malformed_response",
              phase: "parse",
              diagnostic: res.diagnostic,
            }),
        });

        const data = Array.isArray(json.data) ? json.data : [];
        const models: DiscoveredModel[] = [];
        for (const m of data) {
          if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
          const contextWindow = num(m.context_window) ?? num(m.max_input_tokens);
          const maxOut = num(
            m.max_completion_tokens ?? m.max_output_tokens ?? m.max_tokens,
          );
          models.push({
            upstreamModelId: m.id,
            displayName: m.id,
            limits: {
              context: contextWindow ?? OPENAI_DEFAULT_CONTEXT,
              ...(maxOut !== undefined ? { output: maxOut } : {}),
            },
            modalities: { input: ["text"], output: ["text"] },
            raw: m as Record<string, unknown>,
          });
        }
        return models;
      });
    },

    chatComplete(ctx, req) {
      return Effect.gen(function* () {
        const res = yield* providerHttpRequest({
          url: joinUrl(ctx.baseUrl, "/chat/completions"),
          method: "POST",
          headers: authHeaders(ctx),
          body: JSON.stringify(buildChatBody(req, false)),
          ...(req.signal !== undefined
            ? { signal: req.signal }
            : ctx.signal !== undefined
              ? { signal: ctx.signal }
              : {}),
          label: "openai chatComplete",
          operation: "chatComplete",
          ...(req.model !== undefined ? { model: req.model } : {}),
        }).pipe(Effect.mapError(httpFailureToProviderError));

        if (res.status < 200 || res.status >= 300) {
          return yield* Effect.fail(
            providerHttpError(
              res.status,
              res.diagnostic,
              "request",
              "openai chatComplete",
            ),
          );
        }

        const json = yield* Effect.try({
          try: () => JSON.parse(res.bodyText) as Record<string, unknown>,
          catch: () =>
            makeProviderError({
              message: publicProviderErrorMessage("openai chatComplete"),
              category: "malformed_response",
              phase: "parse",
              diagnostic: res.diagnostic,
            }),
        });

        const choicesRaw = Array.isArray(json.choices) ? json.choices : [];
        const choices = choicesRaw
          .map((c, i) => assembleChoice(c, i))
          .filter((c): c is ChatResponse["choices"][number] => c !== null);
        const id = str(json.id) ?? cryptoRandomId();
        const usageResult = parseOpenAIUsageResult(json.usage);
        return {
          id,
          model: str(json.model) ?? req.model,
          choices:
            choices.length > 0
              ? choices
              : [
                  {
                    index: 0,
                    message: { role: "assistant" as const, content: "" },
                    finishReason: "stop",
                  },
                ],
          usage:
            usageResult.status === "reported"
              ? usageResult.usage
              : { ...ZERO_USAGE },
          usageStatus: usageResult.status,
          usageMissingReason:
            usageResult.status === "missing" ? usageResult.reason : undefined,
          providerRequestId: res.headers.get("x-request-id") ?? id,
        };
      });
    },

    async *streamChat(ctx, req): AsyncGenerator<StreamChunk, void, void> {
      const res = await fetch(joinUrl(ctx.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: authHeaders(ctx),
        body: JSON.stringify(buildChatBody(req, true)),
        signal: req.signal ?? ctx.signal ?? null,
      });
      // Throw typed pre-stream errors so fallback can classify 429/5xx.
      if (!res.ok) {
        throw providerHttpError(
          res.status,
          await safeText(res),
          "headers",
          "openai streamChat",
        );
      }
      if (!res.body) {
        throw providerHttpError(502, "empty body", "headers", "openai streamChat");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | undefined;
      /**
       * Structured usage parse state — truthiness on `chunk.usage` alone is
       * unsafe: after a valid report, `usage:null` must invalidate, not leave
       * stale 10/5 billable. Pre-final mid-stream `usage:null` is normal and
       * ignored until a report exists.
       *
       * Held on a box so nested/loop mutations stay visible to the type checker.
       */
      type StreamUsageState =
        | { kind: "none" }
        | { kind: "reported"; usage: ChatResponse["usage"] }
        | { kind: "invalidated"; reason: string };
      const usageBox: { state: StreamUsageState } = { state: { kind: "none" } };
      let sawDone = false;
      let sawMalformedSse = false;

      try {
        while (true) {
          let value: Uint8Array | undefined;
          let done: boolean;
          try {
            ({ value, done } = await reader.read());
          } catch (err) {
            // Body read after headers: upstream may have accepted. Never failover.
            throw makeProviderError({
              message: publicProviderErrorMessage("openai streamChat"),
              category: "connection",
              phase: "body",
              fallbackEligible: false,
              maybeAcceptedUpstream: true,
              retryable: false,
              diagnostic:
                err instanceof Error ? err.message.slice(0, 500) : String(err),
            });
          }
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nlIdx: number;
          while ((nlIdx = buffer.indexOf("\n")) !== -1) {
            let line = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            line = line.trim();
            if (line.length === 0) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === OPENAI_SSE_DONE_PAYLOAD) {
              sawDone = true;
              if (sawMalformedSse) {
                yield {
                  type: "error",
                  error: {
                    code: "malformed_sse",
                    message: "Upstream stream contained malformed SSE JSON",
                  },
                };
              }
              // Protocol terminal ok only when SSE clean and usage not invalidated.
              const uState = usageBox.state;
              const streamOk =
                !sawMalformedSse && uState.kind !== "invalidated";
              const usage =
                streamOk && uState.kind === "reported" ? uState.usage : undefined;
              yield {
                type: "done",
                finishReason,
                streamComplete: streamOk,
                ...(usage ? { usage } : {}),
              };
              return;
            }
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // Surface via streamComplete=false + error; do not silently drop.
              sawMalformedSse = true;
              continue;
            }
            // Key present (including null) must go through structured state.
            if ("usage" in chunk) {
              const raw = chunk.usage;
              const cur = usageBox.state;
              if (cur.kind !== "invalidated") {
                if (raw === null || raw === undefined) {
                  // Normal pre-final null — only fatal after a reported usage.
                  if (cur.kind === "reported") {
                    usageBox.state = {
                      kind: "invalidated",
                      reason: "usage_null_after_reported",
                    };
                  }
                } else {
                  const parsed = parseOpenAIUsageResult(raw);
                  if (parsed.status === "reported") {
                    usageBox.state = {
                      kind: "reported",
                      usage: {
                        ...parsed.usage,
                        cacheAccounting:
                          parsed.usage.cacheAccounting ?? "subset",
                      },
                    };
                  } else {
                    // Present but incomplete/malformed → fail closed.
                    usageBox.state = {
                      kind: "invalidated",
                      reason: parsed.reason || "usage_malformed",
                    };
                  }
                }
              }
            }
            const choicesRaw = Array.isArray(chunk.choices) ? chunk.choices : [];
            for (const c of choicesRaw) {
              if (!c || typeof c !== "object") continue;
              const co = c as Record<string, unknown>;
              const fr = str(co.finish_reason);
              if (fr) finishReason = fr;
              const deltaRaw = co.delta as Record<string, unknown> | undefined;
              if (!deltaRaw) continue;
              const delta: StreamChunk["delta"] = {};
              const content = str(deltaRaw.content);
              if (content) delta.content = content;
              const reasoning =
                str(deltaRaw.reasoning_content) ??
                str(typeof deltaRaw.reasoning === "string" ? deltaRaw.reasoning : undefined) ??
                str((deltaRaw.reasoning as Record<string, unknown> | undefined)?.text) ??
                str(deltaRaw.thinking);
              if (reasoning) delta.reasoning = reasoning;
              const tc = deltaRaw.tool_calls as unknown[] | undefined;
              if (tc) delta.toolCalls = tc;
              if (content || reasoning || tc) {
                yield { type: "delta", delta };
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (sawMalformedSse) {
        yield {
          type: "error",
          error: {
            code: "malformed_sse",
            message: "Upstream stream contained malformed SSE JSON",
          },
        };
      }
      // EOF without [DONE] is truncated — usage (if any) is not authoritative.
      const uState = usageBox.state;
      const streamOk =
        sawDone && !sawMalformedSse && uState.kind !== "invalidated";
      const usage =
        streamOk && uState.kind === "reported" ? uState.usage : undefined;
      yield {
        type: "done",
        finishReason,
        streamComplete: streamOk,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

function cryptoRandomId(): string {
  return "resp_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}