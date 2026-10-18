import {
  expect,
  MOCK_ERROR_MESSAGE,
  MOCK_ERROR_TRIGGER,
  MOCK_REPLY,
  reliableClick,
  setupMockPipeline,
  test,
  type MockPipeline,
} from "./helpers.ts";

/**
 * End-to-end coverage of the core product path against the mock provider:
 * provision a provider + model + customer + API key through the admin UI, then
 * drive real traffic through the /v1 gateway and confirm it settles into
 * analytics/dashboard, plus a streamed playground chat.
 *
 * `pipeline` is provisioned once (first test) and reused; the other tests skip
 * if provisioning failed.
 */
let pipeline: MockPipeline | undefined;

test.describe("gateway / billing / analytics / playground", () => {
  test("provisions a pipeline and settles a /v1 chat completion", async ({ page, request }) => {
    pipeline = await setupMockPipeline(page);

    const res = await request.post("/v1/chat/completions", {
      headers: { Authorization: `Bearer ${pipeline.apiKey}` },
      data: {
        model: pipeline.modelAlias,
        messages: [{ role: "user", content: "Hello gateway" }],
        stream: false,
      },
    });
    expect(res.status(), "gateway responds 200").toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("mock provider");
    expect(body.usage.prompt_tokens).toBe(1000);
    expect(body.usage.completion_tokens).toBe(2000);
    expect(body.usage.total_tokens).toBe(3000);

    // Usage is recorded + attributed → the customer shows in analytics.
    await page.goto("/analytics");
    await expect(page.getByText("Top customers by spend")).toBeVisible();
    await expect(page.getByText(pipeline.customerName).first()).toBeVisible();
  });

  test("dashboard reflects customers, providers and a balance", async ({ page }) => {
    test.skip(!pipeline, "pipeline not provisioned");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Customer balances")).toBeVisible();
  });

  test("playground streams a completion from the mock provider", async ({ page }) => {
    test.skip(!pipeline, "pipeline not provisioned");
    await page.goto("/playground");

    // A model is auto-selected, enabling the composer.
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Hello playground");
    await reliableClick(page.getByRole("button", { name: "Send", exact: true }));

    // The provider's streamed reply renders. Completion is asserted via the
    // composer flipping back from "Stop" to "Send" (a stable signal). The
    // in-stream 'done' badge + usage line are transient — the StreamPanel is
    // cleared and the reply folded into the chat on completion — so the
    // event→state mapping (content/reasoning accumulation, usage, cost/billed,
    // error terminal state) is covered by the unit test
    // apps/admin/src/pages/playground/__tests__/stream-utils.test.ts rather
    // than asserted here.
    await expect(page.getByText(MOCK_REPLY).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  });

  test("/v1 errors follow the OpenAI/Anthropic contracts and never leak upstream", async ({ request }) => {
    test.skip(!pipeline, "pipeline not provisioned");
    const auth = { Authorization: `Bearer ${pipeline!.apiKey}` };
    const messages = [{ role: "user", content: `Please fail: ${MOCK_ERROR_TRIGGER}` }];
    const assertNoUpstreamLeak = (text: string) => {
      expect(text).not.toContain(MOCK_ERROR_MESSAGE);
      expect(text).not.toContain("HTTP 400");
      expect(text).not.toContain("chatComplete");
      expect(text).not.toContain("streamChat");
    };
    const providerRejected = {
      error: {
        message: "The model provider rejected the request.",
        type: "server_error",
        param: null,
        code: "provider_rejected",
      },
    };

    // One behavior: the TokenPanel-Version header changes nothing on /v1.
    for (const headers of [auth, { ...auth, "TokenPanel-Version": "2" }]) {
      const res = await request.post("/v1/chat/completions", {
        headers,
        data: { model: pipeline!.modelAlias, messages, stream: false },
      });
      expect(res.status()).toBe(502);
      expect(res.headers()["x-should-retry"]).toBe("false");
      expect(res.headers()["tokenpanel-version"]).toBeUndefined();
      const text = await res.text();
      assertNoUpstreamLeak(text);
      expect(JSON.parse(text)).toEqual(providerRejected);
    }

    const stream = await request.post("/v1/chat/completions", {
      headers: auth,
      data: { model: pipeline!.modelAlias, messages, stream: true },
    });
    const streamText = await stream.text();
    assertNoUpstreamLeak(streamText);
    expect(streamText).toContain(`data: ${JSON.stringify(providerRejected)}`);

    const anthropic = await request.post("/v1/messages", {
      headers: auth,
      data: { model: pipeline!.modelAlias, max_tokens: 64, messages },
    });
    expect(anthropic.status()).toBe(502);
    const anthropicText = await anthropic.text();
    assertNoUpstreamLeak(anthropicText);
    expect(JSON.parse(anthropicText)).toEqual({
      type: "error",
      error: {
        type: "api_error",
        code: "provider_rejected",
        message: "The model provider rejected the request.",
      },
    });

    const anthropicStream = await request.post("/v1/messages", {
      headers: auth,
      data: { model: pipeline!.modelAlias, max_tokens: 64, messages, stream: true },
    });
    const anthropicStreamText = await anthropicStream.text();
    assertNoUpstreamLeak(anthropicStreamText);
    expect(anthropicStreamText).toContain("event: error\n");
    expect(anthropicStreamText).toContain('"code":"provider_rejected"');

    const badKey = await request.post("/v1/chat/completions", {
      headers: { Authorization: "Bearer tp_live_not_a_real_key" },
      data: { model: pipeline!.modelAlias, messages },
    });
    expect(badKey.status()).toBe(401);
    expect((await badKey.json()).error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
  });

  test("playground keeps an upstream error and the provider's reason visible", async ({ page }) => {
    test.skip(!pipeline, "pipeline not provisioned");
    await page.goto("/playground");

    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible();
    await composer.fill(`Please fail: ${MOCK_ERROR_TRIGGER}`);
    await reliableClick(page.getByRole("button", { name: "Send", exact: true }));

    // Stream finished (composer back to Send), and the error is still shown:
    // the classified status plus the upstream body's own message.
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect(page.getByText("HTTP 400").first()).toBeVisible();
    await expect(page.getByText(MOCK_ERROR_MESSAGE).first()).toBeVisible();
  });
});
