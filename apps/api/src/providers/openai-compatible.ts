import type {
  AdapterContext,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  DiscoveredModel,
  ProviderAdapter,
  StreamChunk,
} from "./types.ts";

const OPENAI_DEFAULT_CONTEXT = 0;

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

export function parseUsage(u: unknown): ChatResponse["usage"] {
  if (!u || typeof u !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const o = u as Record<string, unknown>;
  const promptTokens = num(o.prompt_tokens) ?? 0;
  const completionTokens = num(o.completion_tokens) ?? 0;
  const reasoningTokens = num(o.reasoning_tokens);
  const promptTokensDetails =
    typeof o.prompt_tokens_details === "object" && o.prompt_tokens_details !== null
      ? (o.prompt_tokens_details as Record<string, unknown>)
      : undefined;
  const cacheReadTokens =
    num(promptTokensDetails?.cached_tokens) ?? num(o.cache_read_tokens);
  const cacheWriteTokens = num(o.cache_creation_tokens) ?? num(o.cache_write_tokens);
  return {
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: num(o.total_tokens) ?? promptTokens + completionTokens,
  };
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

    async listModels(ctx) {
      const res = await fetch(joinUrl(ctx.baseUrl, "/models"), {
        method: "GET",
        headers: authHeaders(ctx),
        signal: ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`openai listModels ${res.status}: ${await safeText(res)}`);
      }
      const json = (await res.json()) as { data?: OpenAiModel[] };
      const data = Array.isArray(json.data) ? json.data : [];
      const models: DiscoveredModel[] = [];
      for (const m of data) {
        if (!m || typeof m.id !== "string" || m.id.length === 0) continue;
        const contextWindow = num(m.context_window) ?? num(m.max_input_tokens);
        const maxOut = num(m.max_completion_tokens ?? m.max_output_tokens ?? m.max_tokens);
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
    },

    async chatComplete(ctx, req) {
      const res = await fetch(joinUrl(ctx.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: authHeaders(ctx),
        body: JSON.stringify(buildChatBody(req, false)),
        signal: req.signal ?? ctx.signal,
      });
      if (!res.ok) {
        throw new Error(`openai chatComplete ${res.status}: ${await safeText(res)}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const choicesRaw = Array.isArray(json.choices) ? json.choices : [];
      const choices = choicesRaw
        .map((c, i) => assembleChoice(c, i))
        .filter((c): c is ChatResponse["choices"][number] => c !== null);
      const id = str(json.id) ?? cryptoRandomId();
      return {
        id,
        model: str(json.model) ?? req.model,
        choices: choices.length > 0 ? choices : [
          { index: 0, message: { role: "assistant", content: "" }, finishReason: "stop" },
        ],
        usage: parseUsage(json.usage),
        providerRequestId: res.headers.get("x-request-id") ?? id,
      };
    },

    async *streamChat(ctx, req): AsyncGenerator<StreamChunk, void, void> {
      const res = await fetch(joinUrl(ctx.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: authHeaders(ctx),
        body: JSON.stringify(buildChatBody(req, true)),
        signal: req.signal ?? ctx.signal,
      });
      if (!res.ok || !res.body) {
        yield { type: "error", error: { code: `http_${res.status}`, message: await safeText(res) } };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finishReason: string | undefined;
      let lastUsage: ChatResponse["usage"] | undefined;
      try {
        while (true) {
          const { value, done } = await reader.read();
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
            if (payload === "[DONE]") {
              yield { type: "done", finishReason, ...(lastUsage ? { usage: lastUsage } : {}) };
              return;
            }
            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (chunk.usage) lastUsage = parseUsage(chunk.usage);
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
      yield { type: "done", finishReason, ...(lastUsage ? { usage: lastUsage } : {}) };
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