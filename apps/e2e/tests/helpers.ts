import { expect, type Locator, type Page } from "@playwright/test";
import { reliableClick, test } from "./fixtures.ts";

export { expect, reliableClick, test };

// ---------------------------------------------------------------------------
// Mock provider (compose service `mock-provider`, reachable from the API
// container over the compose network). Create a provider with this baseUrl +
// any API key to back discovery / playground / gateway / analytics flows.
// ---------------------------------------------------------------------------
export const MOCK_BASE_URL = "http://mock-provider:8080/v1";
export const MOCK_API_KEY = "mock-key-123";
export const MOCK_MODELS = ["mock-gpt", "mock-gpt-mini"] as const;
export const MOCK_REPLY = "Hello from the mock provider!";
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3099";

// ---------------------------------------------------------------------------
// Primitive interaction helpers
// ---------------------------------------------------------------------------

/** Assert a sonner toast with the given text appears. */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.getByText(text).first()).toBeVisible();
}

/**
 * Open a radix Select trigger and pick an option. Strings match the option's
 * accessible name exactly; pass a RegExp for partial/`name — email` style labels.
 */
export async function selectOption(
  page: Page,
  trigger: Locator,
  optionName: string | RegExp,
): Promise<void> {
  await reliableClick(trigger);
  const option =
    typeof optionName === "string"
      ? page.getByRole("option", { name: optionName, exact: true })
      : page.getByRole("option", { name: optionName });
  await expect(option.first()).toBeVisible();
  await option.first().click({ force: true });
}

/**
 * Accept the NEXT native browser confirm()/alert(). Call BEFORE triggering the
 * action that opens it (customer close, key revoke, plan deactivate, model &
 * entry delete all use native confirm()).
 */
export function acceptNextDialog(page: Page): void {
  page.once("dialog", (dialog) => void dialog.accept());
}

/** The table row that contains a cell with the given text. */
export function rowWith(page: Page, cellText: string): Locator {
  return page.locator("tr", { has: page.getByRole("cell", { name: cellText, exact: true }) });
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface CreateProviderOpts {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** Create an openai-compatible provider via the Add Provider dialog. */
export async function createProvider(page: Page, opts: CreateProviderOpts): Promise<void> {
  await page.goto("/providers");
  await reliableClick(page.getByRole("button", { name: "Add Provider" }).first());
  await expect(page.getByRole("heading", { name: "Add Provider" })).toBeVisible();

  // The preset auto-selects OpenAI; overwrite the fields we care about. The
  // adapter stays openai-compatible (correct for the mock + most presets).
  await page.locator("#prov-name").fill(opts.name);
  await selectOption(page, page.locator("#prov-sdk"), "openai-compatible");
  await page.locator("#prov-url").fill(opts.baseUrl);
  await page.locator("#prov-key").fill(opts.apiKey);
  await reliableClick(page.getByRole("button", { name: "Create provider" }));

  await expectToast(page, "Provider created.");
  await expect(page.getByRole("cell", { name: opts.name, exact: true })).toBeVisible();
}

/** Trigger discovery on a provider row and assert the success toast. */
export async function discoverProvider(page: Page, providerName: string): Promise<void> {
  await page.goto("/providers");
  await reliableClick(rowWith(page, providerName).getByRole("button", { name: "Discover" }));
  await expectToast(page, /Discovered \d+ model/);
}

/** Edit a provider's name via the row Edit dialog. */
export async function renameProvider(page: Page, oldName: string, newName: string): Promise<void> {
  await page.goto("/providers");
  await reliableClick(rowWith(page, oldName).getByRole("button", { name: "Edit" }));
  await expect(page.getByRole("heading", { name: "Edit Provider" })).toBeVisible();
  await page.locator("#prov-name").fill(newName);
  await reliableClick(page.getByRole("button", { name: "Save changes" }));
  await expectToast(page, "Provider updated.");
  await expect(page.getByRole("cell", { name: newName })).toBeVisible();
}

/** Toggle a provider's active switch. */
export async function toggleProviderActive(page: Page, providerName: string): Promise<void> {
  await page.goto("/providers");
  await reliableClick(
    rowWith(page, providerName).getByRole("switch", { name: "Toggle provider active" }),
  );
}

/** Delete a provider via its confirm dialog. */
export async function deleteProvider(page: Page, providerName: string): Promise<void> {
  await page.goto("/providers");
  await reliableClick(rowWith(page, providerName).getByRole("button", { name: "Delete" }));
  await expect(page.getByRole("heading", { name: "Delete provider" })).toBeVisible();
  await reliableClick(
    page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }),
  );
  await expectToast(page, "Provider deleted.");
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface CreateModelOpts {
  alias: string;
  name: string;
  providerName: string;
  upstream: string;
  currency?: string;
  inputPrice?: string;
  outputPrice?: string;
}

/** Create a model with a single primary provider entry. */
export async function createModel(page: Page, opts: CreateModelOpts): Promise<void> {
  await page.goto("/models");
  await reliableClick(page.getByRole("button", { name: "Add Model" }).first());
  await expect(page.getByRole("heading", { name: "Add model", exact: true })).toBeVisible();

  await page.locator("#m-alias").fill(opts.alias);
  await page.locator("#m-name").fill(opts.name);
  await page.locator("#m-ctx").fill("8192");
  await page.locator("#m-ipm").fill(opts.inputPrice ?? "1000");
  await page.locator("#m-opm").fill(opts.outputPrice ?? "2000");
  await page.locator("#m-cur").fill(opts.currency ?? "USD");
  await page.locator("#m-margin").fill("0");
  await selectOption(page, page.locator("#m-prov"), opts.providerName);
  await page.locator("#m-up").fill(opts.upstream);

  await reliableClick(page.getByRole("button", { name: "Create", exact: true }));

  // Returns to a hydrated edit view; verify via the list.
  await page.goto("/models");
  await expect(page.getByRole("cell", { name: opts.alias, exact: true })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface CreateCustomerOpts {
  name: string;
  email?: string;
}

/** Create a customer; the detail drawer auto-opens for the new customer. */
export async function createCustomer(page: Page, opts: CreateCustomerOpts): Promise<void> {
  await page.goto("/customers");
  await reliableClick(page.getByRole("button", { name: "Add Customer" }).first());
  await expect(page.getByRole("heading", { name: "Add customer", exact: true })).toBeVisible();
  await page.locator("#cust-name").fill(opts.name);
  if (opts.email) await page.locator("#cust-email").fill(opts.email);
  await reliableClick(page.getByRole("button", { name: "Save", exact: true }));
  // The detail drawer auto-opens for the new customer (leave it open).
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(opts.name).first()).toBeVisible();
}

/** Open a customer's detail drawer from the list. */
export async function openCustomerDrawer(page: Page, customerName: string): Promise<void> {
  await page.goto("/customers");
  await reliableClick(rowWith(page, customerName).getByRole("button", { name: "Manage" }));
}

/** Add credit to the open customer drawer. */
export async function addCustomerCredit(
  page: Page,
  opts: { amount: string; currency: string },
): Promise<void> {
  await reliableClick(page.getByRole("button", { name: "Add Credit" }));
  await expect(
    page.getByRole("heading", { name: "Add credit / adjustment" }),
  ).toBeVisible();
  await page.locator("#bal-amount").fill(opts.amount);
  await page.locator("#bal-currency").fill(opts.currency);
  await reliableClick(page.getByRole("button", { name: "Apply", exact: true }));
  // A Top-up ledger entry appears in the balance history.
  await expect(page.getByText("Top-up").first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface CreatePlanOpts {
  name: string;
  price?: string;
  credit?: string;
  tokens?: string;
}

/** Create a subscription plan via the inline form. */
export async function createPlan(page: Page, opts: CreatePlanOpts): Promise<void> {
  await page.goto("/plans");
  await reliableClick(page.getByRole("button", { name: "Add Plan" }).first());
  await page.locator("#plan-name").fill(opts.name);
  await selectOption(page, page.locator("#plan-interval"), "month");
  await page.locator("#plan-interval-count").fill("1");
  await page.locator("#plan-price-amount").fill(opts.price ?? "1000");
  await page.locator("#plan-price-currency").fill("USD");
  await page.locator("#plan-credit-amount").fill(opts.credit ?? "5000");
  await page.locator("#plan-credit-currency").fill("USD");
  await page.locator("#plan-tokens").fill(opts.tokens ?? "100000");
  await reliableClick(page.getByRole("button", { name: "Create plan" }));
  await expect(page.getByText(opts.name).first()).toBeVisible();
}

// ---------------------------------------------------------------------------
// API keys (customer) — standalone page
// ---------------------------------------------------------------------------

export interface CreateApiKeyOpts {
  customerName: string;
  keyName: string;
  whitelist?: string;
}

/** Create a customer API key and return the revealed `tp_live_…` key. */
export async function createCustomerApiKey(page: Page, opts: CreateApiKeyOpts): Promise<string> {
  await page.goto("/api-keys");
  await selectOption(page, page.locator("#apikey-customer"), new RegExp(opts.customerName));
  await reliableClick(page.getByRole("button", { name: "Create Key", exact: true }));
  await page.locator("#apikey-name").fill(opts.keyName);
  if (opts.whitelist) await page.locator("#apikey-whitelist").fill(opts.whitelist);
  await reliableClick(page.getByRole("button", { name: "Create Key", exact: true }));

  await expect(page.getByText(/Key created\. Copy it now/)).toBeVisible();
  const key = (await page.locator("code", { hasText: "tp_live_" }).first().textContent())?.trim();
  expect(key, "revealed customer API key").toBeTruthy();
  expect(key!.startsWith("tp_live_"), "key has tp_live_ prefix").toBeTruthy();
  return key!;
}

// ---------------------------------------------------------------------------
// Management keys
// ---------------------------------------------------------------------------

/** Create a management key (default scopes) and return the `tp_mgmt_…` key. */
export async function createManagementKey(page: Page, name: string): Promise<string> {
  await page.goto("/management-keys");
  await reliableClick(page.getByRole("button", { name: "Create Key", exact: true }));
  await page.locator("#mgmt-name").fill(name);
  await reliableClick(page.getByRole("button", { name: "Create key", exact: true }));

  await expect(page.getByText(/Management key created\. Copy it now/)).toBeVisible();
  const key = (await page.locator("code", { hasText: "tp_mgmt_" }).first().textContent())?.trim();
  expect(key, "revealed management key").toBeTruthy();
  expect(key!.startsWith("tp_mgmt_"), "key has tp_mgmt_ prefix").toBeTruthy();
  return key!;
}

// ---------------------------------------------------------------------------
// Full mock-backed pipeline (provider → discover → model → customer → key)
// ---------------------------------------------------------------------------

export interface MockPipeline {
  providerName: string;
  modelAlias: string;
  modelName: string;
  customerName: string;
  customerEmail: string;
  apiKey: string;
}

/**
 * Provision everything needed for gateway/playground/analytics flows against the
 * mock provider. Uses unique names so it is safe to call once per suite.
 */
export async function setupMockPipeline(page: Page, suffix = ""): Promise<MockPipeline> {
  const providerName = `E2E Mock Provider${suffix}`;
  const modelAlias = `mock-gpt${suffix.toLowerCase().replace(/\s+/g, "-")}`;
  const modelName = `Mock GPT${suffix}`;
  const customerName = `E2E Gateway Customer${suffix}`;
  const customerEmail = `gateway${suffix.toLowerCase().replace(/\s+/g, "")}@e2e.local`;

  await createProvider(page, { name: providerName, baseUrl: MOCK_BASE_URL, apiKey: MOCK_API_KEY });
  await discoverProvider(page, providerName);
  await createModel(page, {
    alias: modelAlias,
    name: modelName,
    providerName,
    upstream: "mock-gpt",
    currency: "USD",
    inputPrice: "1000",
    outputPrice: "2000",
  });
  await createCustomer(page, { name: customerName, email: customerEmail });
  await addCustomerCredit(page, { amount: "1000000", currency: "USD" });
  const apiKey = await createCustomerApiKey(page, { customerName, keyName: "gateway-key" });

  return { providerName, modelAlias, modelName, customerName, customerEmail, apiKey };
}
