import type {
  AdapterContext,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  ProviderAdapter,
  StreamChunk,
} from "./types.ts";
import {
  parseAnthropicProviderUsage,
  parseAnthropicStreamUsageFragment,
  mergeAnthropicStreamUsage,
  isAnthropicStreamUsageComplete,
  toTokenUsage,
  ZERO_USAGE,
  type ProviderUsage,
  type AnthropicStreamUsageAccum,
} from "./provider-usage.ts";

// Re-export for tests that historically imported merge from this module.
export { mergeAnthropicStreamUsage, isAnthropicStreamUsageComplete } from "./provider-usage.ts";
import {
  providerHttpError,
  publicProviderErrorMessage,
  ProviderError,
} from "./provider-errors.ts";

const ANTHROPIC_VERSION = "2023-06-01";
/** Non-authoritative discovery fallback when upstream omits context (not billing). */
const ANTHROPIC_DEFAULT_CONTEXT = 200_000;
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

type AnthropicModel = {
  id: string;
  display_name?: string;
  created_at?: number;
  type?: string;
  [k: string]: unknown;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function headers(ctx: AdapterContext, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "x-api-key": ctx.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };
  if (extra) Object.assign(h, extra);
  if (ctx.headers) Object.assign(h, ctx.headers);
  return h;
}

export function joinUrl(base: string, path: string): string {
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1);
  if (!base.endsWith("/") && !path.startsWith("/")) return base + "/" + path;
  return base + path;
}

export function stringifyContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const p of content) {
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("");
}

export function splitSystemAndMessages(req: ChatRequest): {
  system: string | undefined;
  messages: { role: string; content: string | unknown[] }[];
} {
  let system: string | undefined;
  const msgs: { role: string; content: string | unknown[] }[] = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      system = (system ? system + "\n\n" : "") + stringifyContent(m.content);
      continue;
    }
    if (m.role === "tool") {
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: stringifyContent(m.content),
          },
        ],
      });
      continue;
    }
    msgs.push({ role: m.role, content: m.content });
  }
  return { system, messages: msgs };
}

export function translateTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    if (t && typeof t === "object" && "function" in (t as Record<string, unknown>)) {
      return t;
    }
    return { name: "tool", description: "", input_schema: {} };
  });
}

export function buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = splitSystemAndMessages(req);

  // Resolve extended-thinking budget first — it constrains max_tokens + temperature.
  let thinkingBudget: number | undefined;
  if (req.reasoning !== undefined && typeof req.reasoning === "object" && req.reasoning?.effort) {
    thinkingBudget = req.reasoning.effort === "low" ? 2048 : req.reasoning.effort === "medium" ? 8192 : 16384;
  }

  // Anthropic requires max_tokens > budget_tokens when thinking is enabled.
  // Bump max_tokens to budget + a comfortable output margin if the caller's
  // value is too small (or unset).
  let maxTokens = req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (thinkingBudget !== undefined && maxTokens <= thinkingBudget) {
    maxTokens = thinkingBudget + 4096;
  }

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    messages,
    stream,
  };
  if (system) body.system = system;

  // When thinking is enabled Anthropic requires temperature=1 (the default).
  // Drop the field entirely so the API uses its default rather than rejecting.
  if (thinkingBudget === undefined) {
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.stop !== undefined) body.stop_sequences = req.stop;
  }

  const tools = translateTools(req.tools);
  if (tools) body.tools = tools;
  if (req.toolChoice !== undefined) body.tool_choice = req.toolChoice;
  if (thinkingBudget !== undefined) {
    body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }
  if (req.extra) Object.assign(body, req.extra);
  return body;
}

export function mapUsage(u: unknown): ChatResponse["usage"] {
  const r = parseAnthropicProviderUsage(u);
  if (r.status === "missing") return { ...ZERO_USAGE };
  return r.usage;
}

export function parseAnthropicUsageResult(u: unknown): ProviderUsage {
  return parseAnthropicProviderUsage(u);
}

function stopReasonToFinishReason(sr: unknown): string {
  return str(sr) ?? "stop";
}

export function assembleMessage(raw: unknown): ChatMessage {
  if (!raw || typeof raw !== "object") return { role: "assistant", content: "" };
  const r = raw as Record<string, unknown>;
  const contentBlocks = Array.isArray(r.content) ? r.content : [];
  const textParts: string[] = [];
  const toolUses: unknown[] = [];
  for (const b of contentBlocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolUses.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      textParts.push(block.thinking);
    }
  }
  const message: ChatMessage = {
    role: "assistant",
    content: textParts.join(""),
  };
  if (toolUses.length > 0) message.toolCalls = toolUses;
  return message;
}

export function createAnthropicCompatibleAdapter(): ProviderAdapter {
  return {
    sdkType: "anthropic-compatible",

    async listModels(ctx) {
      const res = await fetch(joinUrl(ctx.baseUrl, "/models"), {
        method: "GET",
        headers: headers(ctx),
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`anthropic listModels ${res.status}: ${await safeText(res)}`);
      }
      const json = (await res.json()) as { data?: AnthropicModel[] };
      const data = Array.isArray(json.data) ? json.data : [];
      const models: DiscoveredModel[] = [];
      for (const m of data) {
        if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
        const displayName = str(m.display_name) ?? m.id;
        models.push({
          upstreamModelId: m.id,
          displayName,
          limits: { context: ANTHROPIC_DEFAULT_CONTEXT },
          modalities: { input: ["text"], output: ["text"] },
          raw: m as Record<string, unknown>,
        });
      }
      return models;
    },

    async chatComplete(ctx, req) {
      const res = await fetch(joinUrl(ctx.baseUrl, "/messages"), {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify(buildBody(req, false)),
        signal: req.signal ?? ctx.signal,
      });
      if (!res.ok) {
        throw providerHttpError(
          res.status,
          await safeText(res),
          "request",
          "anthropic chatComplete",
        );
      }
      const json = (await res.json()) as Record<string, unknown>;
      const id = str(json.id) ?? cryptoRandomId();
      const message = assembleMessage(json);
      const usageResult = parseAnthropicUsageResult(json.usage);
      return {
        id,
        model: str(json.model) ?? req.model,
        choices: [
          {
            index: 0,
            message,
            finishReason: stopReasonToFinishReason(json.stop_reason),
          },
        ],
        usage:
          usageResult.status === "reported"
            ? usageResult.usage
            : { ...ZERO_USAGE },
        usageStatus: usageResult.status,
        usageMissingReason:
          usageResult.status === "missing" ? usageResult.reason : undefined,
        providerRequestId: res.headers.get("request-id") ?? id,
      };
    },

    async *streamChat(ctx, req): AsyncGenerator<StreamChunk, void, void> {
      const res = await fetch(joinUrl(ctx.baseUrl, "/messages"), {
        method: "POST",
        headers: headers(ctx),
        body: JSON.stringify(buildBody(req, true)),
        signal: req.signal ?? ctx.signal,
      });
      if (!res.ok) {
        throw providerHttpError(
          res.status,
          await safeText(res),
          "headers",
          "anthropic streamChat",
        );
      }
      if (!res.body) {
        throw providerHttpError(502, "empty body", "headers", "anthropic streamChat");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | undefined;
      let lastUsage: AnthropicStreamUsageAccum | undefined;
      let sawMessageStop = false;
      let sawMalformedSse = false;
      // Any present-but-unparseable usage fragment invalidates final usage even
      // if an earlier fragment looked complete (stale billable counts).
      let sawMalformedUsage = false;

      /**
       * Merge a usage fragment. **Any** present `usage` value that cannot be
       * merged as a valid fragment invalidates final settlement — including
       * non-objects (`"bad"`), empty objects, and auxiliary-only payloads.
       * Prior complete 10/5 must not remain billable after a later bad usage.
       */
      const mergeStreamUsageOrFlagMalformed = (raw: unknown): void => {
        // Present but non-object (string/number/null/array) → invalid.
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          sawMalformedUsage = true;
          return;
        }
        const frag = parseAnthropicStreamUsageFragment(raw);
        if (!frag) {
          // Object present but not a usable input/output fragment (empty,
          // auxiliary-only, or malformed numbers) → fail closed.
          sawMalformedUsage = true;
          return;
        }
        lastUsage = mergeAnthropicStreamUsage(lastUsage, frag);
      };

      try {
        while (true) {
          let value: Uint8Array | undefined;
          let done: boolean;
          try {
            ({ value, done } = await reader.read());
          } catch (err) {
            // Body read after headers: upstream may have accepted. Never failover.
            throw new ProviderError({
              message: publicProviderErrorMessage("anthropic streamChat"),
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
          let sep: number;
          while ((sep = buffer.indexOf("\n")) !== -1) {
            let line = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 1);
            line = line.trim();
            if (line.length === 0) continue;
            if (line.startsWith("event:")) continue;
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload.length === 0) continue;
            let evt: Record<string, unknown>;
            try {
              evt = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // Malformed SSE: fail closed — never treat stream as complete.
              sawMalformedSse = true;
              continue;
            }
            const type = str(evt.type);
            if (!type) continue;
            switch (type) {
              case "message_start": {
                const msg = evt.message as Record<string, unknown> | undefined;
                // Key present (even null/string/"bad") must be validated — not only truthy objects.
                if (msg && "usage" in msg) {
                  mergeStreamUsageOrFlagMalformed(msg.usage);
                }
                break;
              }
              case "content_block_start": {
                const block = evt.content_block as Record<string, unknown> | undefined;
                if (str(block?.type) === "tool_use") {
                  yield {
                    type: "delta",
                    delta: { toolCalls: [{ index: num(evt.index) ?? 0, type: "tool_use", id: block?.id, name: block?.name }] },
                  };
                }
                break;
              }
              case "content_block_delta": {
                const delta = evt.delta as Record<string, unknown> | undefined;
                if (!delta) break;
                const dtype = str(delta.type);
                if (dtype === "text_delta") {
                  const t = str(delta.text);
                  if (t) yield { type: "delta", delta: { content: t } };
                } else if (dtype === "input_json_delta") {
                  yield { type: "delta", delta: { toolCalls: [{ partial_json: delta.partial_json }] } };
                } else if (dtype === "thinking_delta") {
                  const t = str(delta.thinking);
                  if (t) yield { type: "delta", delta: { reasoning: t } };
                }
                break;
              }
              case "content_block_stop": {
                break;
              }
              case "message_delta": {
                const delta = evt.delta as Record<string, unknown> | undefined;
                if (delta?.stop_reason) finishReason = stopReasonToFinishReason(delta.stop_reason);
                // Key present (even null/string/"bad") must invalidate, not be ignored.
                if ("usage" in evt) {
                  mergeStreamUsageOrFlagMalformed(evt.usage);
                }
                break;
              }
              case "message_stop":
                sawMessageStop = true;
                break;
              case "ping":
              default:
                break;
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
      // EOF without message_stop, or malformed SSE/usage, or incomplete sides:
      // not authoritative for settlement (routes check streamComplete + usage).
      const streamOk =
        sawMessageStop && !sawMalformedSse && !sawMalformedUsage;
      const usage =
        streamOk && isAnthropicStreamUsageComplete(lastUsage)
          ? toTokenUsage(lastUsage)
          : undefined;
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
  return "msg_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}