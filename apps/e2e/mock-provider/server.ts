/**
 * Minimal OpenAI-compatible mock provider for E2E tests.
 *
 * Runs as the `mock-provider` compose service. The API container reaches it at
 * http://mock-provider:8080/v1 (create a provider with that baseUrl + any key).
 *
 * Implements exactly what the openai-compatible adapter reads:
 *  - GET  {base}/models            → catalog discovery (data[].id/context_window/…)
 *  - POST {base}/chat/completions  → non-streaming JSON and streaming SSE.
 *
 * Usage is deterministic with integer prompt_tokens + completion_tokens — both
 * are REQUIRED for the API to settle usage (otherwise it goes to the outbox and
 * nothing is billed/recorded). Token counts are large enough that a model with
 * a nonzero price produces a measurable balance debit.
 */
const PORT = Number(process.env.MOCK_PORT ?? 8080);

const MODELS = [
  {
    id: "mock-gpt",
    object: "model",
    created: 1_700_000_000,
    owned_by: "mock",
    context_window: 8192,
    max_completion_tokens: 2048,
  },
  {
    id: "mock-gpt-mini",
    object: "model",
    created: 1_700_000_000,
    owned_by: "mock",
    context_window: 4096,
    max_completion_tokens: 1024,
  },
];

const PROMPT_TOKENS = 1000;
const COMPLETION_TOKENS = 2000;
const REPLY = "Hello from the mock provider!";

function usage() {
  return {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
  };
}

function completionBody(model: string) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
    ],
    usage: usage(),
  };
}

function sseStream(model: string): string {
  const base = {
    id: "chatcmpl-mock-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const lines: string[] = [];
  const push = (obj: unknown) => lines.push(`data: ${JSON.stringify(obj)}\n\n`);
  for (const piece of ["Hello from the ", "mock provider!"]) {
    push({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  push({ ...base, choices: [], usage: usage() });
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return Response.json({ ok: true });

    if (req.method === "GET" && path.endsWith("/models")) {
      return Response.json({ object: "list", data: MODELS });
    }

    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      const body = (await req.json().catch(() => ({}))) as { model?: unknown; stream?: unknown };
      const model = typeof body.model === "string" ? body.model : "mock-gpt";
      if (body.stream) {
        return new Response(sseStream(model), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }
      return Response.json(completionBody(model));
    }

    return Response.json({ error: "not_found", path }, { status: 404 });
  },
});

console.log(`mock-provider listening on :${server.port}`);
