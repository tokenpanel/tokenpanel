import {
  expect,
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
    await expect(page.getByText("Total customer balance")).toBeVisible();
  });

  test("playground streams a completion from the mock provider", async ({ page }) => {
    test.skip(!pipeline, "pipeline not provisioned");
    await page.goto("/playground");

    // A model is auto-selected, enabling the composer.
    const composer = page.getByPlaceholder("Start a new message…");
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
});
