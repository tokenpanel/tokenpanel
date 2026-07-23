import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import {
  createProvider,
  selectOption,
  reliableClick,
  rowWith,
  setupMockPipeline,
  type MockPipeline,
} from "./helpers.ts";

/**
 * Core product behaviors the original gateway spec left unasserted. These run
 * AFTER the pipeline is provisioned (gateway.spec.ts) and reuse it. Everything
 * here drives the REAL gateway (/v1/*) and management API (/api/management/*) over
 * HTTP and asserts on concrete response/balance state — no UI-only proxies.
 *
 * Behaviors covered:
 *  - usage → exact synchronous balance debit (the product's reason to exist),
 *  - rolling rate-limit enforcement (plan rule → 429 on the N+1th request),
 *  - fallback failover (dead primary entry → request still succeeds via #2),
 *  - the Anthropic /v1/messages surface against an openai-compatible upstream,
 *  - the management API: scope-gated reads with balance redaction + the
 *    customer-key/management-key auth boundary.
 */

const TOKEN_KEY = "tp_admin_token";

/** Admin panel JWT (localStorage) so we can drive admin APIs directly. */
async function adminToken(page: Page): Promise<string> {
  await page.goto("/");
  const token = await page.evaluate((k: string) => localStorage.getItem(k), TOKEN_KEY);
  expect(token, "admin JWT present").toBeTruthy();
  return token!;
}

// The shared pipeline is provisioned by gateway.spec.ts (runs first, workers:1).
let pipeline: MockPipeline | undefined;

test.describe("gateway behaviors: billing / rate-limit / fallback / protocols", () => {
  test.beforeEach(async ({ page }) => {
    if (pipeline) return;
    // Re-provision only if the gateway spec's pipeline is missing (defensive;
    // in the normal sequential run it already exists).
    pipeline = await setupMockPipeline(page, " Behaviors");
  });

  test("a /v1 completion debits the customer balance by the exact price", async ({
    page,
    request,
  }) => {
    const jwt = await adminToken(page);
    const auth = { Authorization: `Bearer ${jwt}` };

    // Resolve the pipeline customer's id + balance via the admin API (exact
    // integer units — the UI's formatMoney rounds to cents and would hide a
    // sub-cent debit).
    const list = await request.get(
      `/admin/customers?q=${encodeURIComponent(pipeline!.customerName)}`,
      { headers: auth },
    );
    expect(list.status()).toBe(200);
    const items = (await list.json()).items as Array<{
      _id: string;
      name: string;
      balance: { amountUnits: number; currency: string };
    }>;
    const customer = items.find((c) => c.name === pipeline!.customerName);
    expect(customer, "pipeline customer exists").toBeTruthy();
    const before = customer!.balance.amountUnits;

    const res = await request.post("/v1/chat/completions", {
      headers: { Authorization: `Bearer ${pipeline!.apiKey}` },
      data: {
        model: pipeline!.modelAlias,
        messages: [{ role: "user", content: "bill me" }],
        stream: false,
      },
    });
    expect(res.status(), "completion succeeds").toBe(200);

    // Settlement is synchronous for reported usage (the mock always reports
    // integer tokens), so the debit is committed before the response returns.
    const after = await request.get(`/admin/customers/${customer!._id}`, {
      headers: auth,
    });
    expect(after.status()).toBe(200);
    const afterUnits = (await after.json()).balance.amountUnits as number;

    // Price schedule: input 1000/M × 1000 prompt = 1 unit, output 2000/M × 2000
    // completion = 4 units → exactly 5 minor units per call. Asserting the exact
    // delta catches both "not billed" and "mis-billed" regressions.
    expect(before - afterUnits, "balance debited exactly 5 units").toBe(5);
  });

  test("a plan rate-limit rule returns 429 once the request cap is hit", async ({
    page,
    request,
  }) => {
    const jwt = await adminToken(page);
    const auth = { Authorization: `Bearer ${jwt}` };

    // Plan with a hard requests cap of 2 per hour (customer scope).
    const planRes = await request.post("/admin/plans", {
      headers: auth,
      data: {
        name: "RL Requests Cap2",
        price: { amountUnits: 0, currency: "USD" },
        interval: "month",
        rateLimits: [
          { windowSeconds: 3600, dimension: "requests", capValue: 2, scope: "customer" },
        ],
      },
    });
    expect(planRes.status(), "plan created").toBe(201);
    const planId = (await planRes.json())._id as string;
    expect(planId, "plan id returned").toBeTruthy();

    // Dedicated customer + credit + subscription + key (isolated from pipeline).
    const custRes = await request.post("/admin/customers", {
      headers: auth,
      data: { name: "RL Cap2 Customer", email: "rl-cap2@e2e.local" },
    });
    expect(custRes.status()).toBe(201);
    const customerId = (await custRes.json())._id as string;

    const credit = await request.post(`/admin/customers/${customerId}/balance`, {
      headers: auth,
      data: { amountUnits: 1_000_000, currency: "USD", reason: "topup" },
    });
    expect(credit.status(), "credit applied").toBeLessThan(300);

    const sub = await request.post(`/admin/customers/${customerId}/subscription`, {
      headers: auth,
      data: { planId },
    });
    expect(sub.status(), "subscription assigned").toBeLessThan(300);

    const keyRes = await request.post("/admin/api-keys", {
      headers: auth,
      data: { customerId, name: "rl-key" },
    });
    expect(keyRes.status()).toBe(201);
    const apiKey = (await keyRes.json()).key as string;
    expect(apiKey.startsWith("tp_live_")).toBeTruthy();

    // Requests 1 and 2 succeed (cap 2); request 3 trips the rolling window.
    const chat = () =>
      request.post("/v1/chat/completions", {
        headers: { Authorization: `Bearer ${apiKey}` },
        data: {
          model: pipeline!.modelAlias,
          messages: [{ role: "user", content: "rate limit probe" }],
          stream: false,
        },
      });

    expect((await chat()).status(), "request 1 within cap").toBe(200);
    expect((await chat()).status(), "request 2 within cap").toBe(200);

    const limited = await chat();
    expect(limited.status(), "request 3 over cap → 429").toBe(429);
    const body = await limited.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.dimension).toBe("requests");
    expect(body.error.cap).toBe(2);
  });

  test("fails over to the next entry when the primary provider is dead", async ({
    page,
    request,
  }) => {

    // A provider whose upstream is unreachable (non-routable address →
    // connection failure, which is fallback-eligible).
    await createProvider(page, {
      name: "Dead Upstream Provider",
      baseUrl: "http://10.255.255.1:81/v1",
      apiKey: "dead-key",
    });

    // Find the pipeline model, then add the dead provider as priority 0 so it is
    // tried FIRST; the working mock entry stays at priority 1.
    await page.goto("/models");
    await reliableClick(rowWith(page, pipeline!.modelAlias).getByRole("button", { name: "Edit" }));
    await expect(page.getByText("Fallback chain")).toBeVisible();
    await reliableClick(page.getByRole("button", { name: "Add Provider Entry" }));
    await selectOption(page, page.locator("#ae-prov"), "Dead Upstream Provider");
    await page.locator("#ae-up").fill("mock-gpt");
    await reliableClick(page.getByRole("button", { name: "Add entry" }));
    await expect(page.getByText("mock-gpt").first()).toBeVisible();

    // The request must succeed via the fallback. If failover were broken, the
    // dead primary would surface as a 502 (all_providers) instead of the mock's
    // reply.
    const res = await request.post("/v1/chat/completions", {
      headers: { Authorization: `Bearer ${pipeline!.apiKey}` },
      data: {
        model: pipeline!.modelAlias,
        messages: [{ role: "user", content: "failover probe" }],
        stream: false,
      },
    });
    expect(res.status(), "succeeds via fallback entry").toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain("mock provider");
  });

  test("serves the Anthropic /v1/messages surface over an openai-compatible upstream", async ({
    request,
  }) => {
    const res = await request.post("/v1/messages", {
      headers: { Authorization: `Bearer ${pipeline!.apiKey}` },
      data: {
        model: pipeline!.modelAlias,
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello anthropic" }],
      },
    });
    expect(res.status(), "/v1/messages responds 200").toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    const text = (body.content as Array<{ type: string; text: string }>)
      .map((b) => b.text)
      .join("");
    expect(text).toContain("mock provider");
    expect(body.usage.input_tokens).toBe(1000);
    expect(body.usage.output_tokens).toBe(2000);
  });

  test("management API: scope-gated reads, balance redaction, and key-type boundaries", async ({
    page,
    request,
  }) => {
    // Create a management key with ONLY customers:read (uncheck the default
    // models:read so we also prove a non-default scope set is honored).
    await page.goto("/management-keys");
    await reliableClick(page.getByRole("button", { name: "Create Key", exact: true }));
    await page.locator("#mgmt-name").fill("Mgmt Customers Only");
    const scopeBox = (value: string) =>
      page
        .locator("label")
        .filter({ has: page.getByText(value, { exact: true }) })
        .getByRole("checkbox");
    // Default scopes are models:read + customers:read. Uncheck models:read so
    // the key has ONLY customers:read (proves a non-default scope set works).
    await scopeBox("models:read").click({ force: true }); // off (was default)
    await reliableClick(page.getByRole("button", { name: "Create key", exact: true }));
    await expect(page.getByText(/Management key created\. Copy it now/)).toBeVisible();
    const mgmtKey = (await page.locator("code", { hasText: "tp_mgmt_" }).first().textContent())?.trim();
    expect(mgmtKey?.startsWith("tp_mgmt_")).toBeTruthy();

    const auth = { Authorization: `Bearer ${mgmtKey}` };

    // customers:read → can list customers, but balances are redacted (no
    // balances:read scope).
    const customers = await request.get("/api/management/customers", { headers: auth });
    expect(customers.status(), "customers:read → 200").toBe(200);
    const items = (await customers.json()).items as Array<{
      name: string;
      balance?: unknown;
    }>;
    expect(
      items.some((c) => c.name === pipeline!.customerName),
      "pipeline customer visible via management API",
    ).toBeTruthy();
    for (const c of items) {
      expect("balance" in c, `balance redacted for ${c.name}`).toBe(false);
    }

    // Missing scope → 403 (no models:read on this key).
    const models = await request.get("/api/management/models", { headers: auth });
    expect(models.status(), "no models:read → 403").toBe(403);

    // A customer key is NOT a management principal → 401 on the management API.
    const asCustomerKey = await request.get("/api/management/customers", {
      headers: { Authorization: `Bearer ${pipeline!.apiKey}` },
    });
    expect(asCustomerKey.status(), "customer key on /management → 401").toBe(401);

    // And a management key is NOT a panel session → rejected on the admin API.
    const adminAsMgmt = await request.get("/admin/customers", { headers: auth });
    expect(adminAsMgmt.status(), "management key on /admin → 401").toBe(401);
  });
});
