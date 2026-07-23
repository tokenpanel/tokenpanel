import type { Browser, Page } from "@playwright/test";
import { expect, reliableClick, test } from "./fixtures.ts";
import { createCustomer } from "./helpers.ts";

/**
 * Permission-system coverage.
 *
 * The panel is permission-driven end to end:
 *  - the sidebar only renders nav items the member holds (Layout.tsx),
 *  - routes are guarded by RequirePermission ("Access denied"),
 *  - pages gate their write controls + secondary data fetches by atom, and
 *  - the API re-checks every atom server-side (requirePermission → 403).
 *
 * These tests mint members with a KNOWN, limited grant via the invite flow
 * (the only way to create a non-admin), then assert BOTH directions:
 *  - allowed: the member can see/use exactly what they were granted, with no
 *    error (regression guard for pages that used to fire a forbidden secondary
 *    fetch and blank the whole page — e.g. ModelsPage calling /admin/providers
 *    which needs providers:read while the page only needs models:read), and
 *  - denied: the member cannot see or reach what they were NOT granted, in the
 *    UI AND at the API (so a UI-only gate can't silently pass while the server
 *    still serves data, and vice versa).
 */

const TOKEN_KEY = "tp_admin_token";

/** Click the invite-form permission checkbox for a given atom (its <code> label). */
async function grantPermission(page: Page, atom: string): Promise<void> {
  const checkbox = page
    .locator("label")
    .filter({ has: page.getByText(atom, { exact: true }) })
    .getByRole("checkbox");
  await expect(checkbox).toBeVisible();
  await checkbox.click({ force: true });
}

/**
 * As the signed-in admin, create a member invite granting exactly `atoms` and
 * return the one-time signup token. Mirrors the identity spec's reveal scrape.
 */
async function inviteMember(
  page: Page,
  email: string,
  atoms: readonly string[],
): Promise<string> {
  await page.goto("/settings");
  await reliableClick(page.getByRole("tab", { name: "Invites" }));

  await page.locator("#invite-email").fill(email);
  // Role defaults to "member"; the per-atom checkboxes only render for members.
  for (const atom of atoms) await grantPermission(page, atom);
  await reliableClick(page.getByRole("button", { name: "Invite User" }));

  const reveal = page.locator("[data-slot='alert']", {
    hasText: "Invite created. Share this signup link",
  });
  await expect(reveal).toBeVisible();
  const token = (await reveal.locator("code").first().textContent())?.trim();
  expect(token, "invite token revealed").toBeTruthy();
  return token!;
}

/**
 * Accept an invite in a fresh, logged-out context and return the authenticated
 * member page. The member's JWT lands in localStorage under TOKEN_KEY.
 */
async function loginAsMember(
  browser: Browser,
  origin: string,
  token: string,
  username: string,
  password: string,
): Promise<{ page: Page; cleanup: () => Promise<void> }> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`${origin}/signup#/token=${encodeURIComponent(token)}`);
  await expect(page.getByRole("heading", { name: "Accept your invite" })).toBeVisible();
  await page.locator("#invite-username").fill(username);
  await page.locator("#invite-password").fill(password);
  await page.locator("#invite-confirm").fill(password);
  await reliableClick(page.getByRole("button", { name: "Accept invite" }));
  await page.waitForURL(/\/$/);
  return { page, cleanup: () => ctx.close() };
}

/** Read the member's JWT so we can hit the admin API directly (defense-in-depth). */
async function memberToken(page: Page): Promise<string> {
  await page.goto("/");
  const token = await page.evaluate((k: string) => localStorage.getItem(k), TOKEN_KEY);
  expect(token, "member JWT present").toBeTruthy();
  return token!;
}

test.describe("permissions: members see and reach only their grants", () => {
  test("models:read member sees Models (no error) but not Providers/Customers/Dashboard", async ({
    page,
    browser,
  }) => {
    const token = await inviteMember(page, "perm-models@e2e.local", ["models:read"]);
    const origin = new URL(page.url()).origin;
    const member = await loginAsMember(browser, origin, token, "perm_models", "Member-Passw0rd!");

    try {
      // Sidebar renders ONLY granted nav (+ always-visible Orgs/Settings).
      await expect(member.page.getByRole("link", { name: "Models" })).toBeVisible();
      for (const hidden of ["Providers", "Customers", "Plans", "Analytics", "Dashboard"]) {
        await expect(member.page.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
      }

      // The granted page loads WITHOUT error. Regression guard: ModelsPage used
      // to fire /admin/providers (needs providers:read) inside the models load,
      // so a models-only member got a 403 that blanked the page with
      // "Failed to load models". The providers fetch is now best-effort.
      await member.page.goto("/models");
      await expect(member.page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
      await expect(member.page.getByText("Failed to load models")).toHaveCount(0);
    } finally {
      await member.cleanup();
    }
  });

  test("route guard blocks pages the member lacks permission for", async ({ page, browser }) => {
    const token = await inviteMember(page, "perm-guard@e2e.local", ["models:read"]);
    const origin = new URL(page.url()).origin;
    const member = await loginAsMember(browser, origin, token, "perm_guard", "Member-Passw0rd!");

    try {
      await member.page.goto("/providers");
      await expect(member.page.getByRole("heading", { name: "Access denied" })).toBeVisible();
      await expect(member.page.getByText("providers:read")).toBeVisible();

      await member.page.goto("/customers");
      await expect(member.page.getByRole("heading", { name: "Access denied" })).toBeVisible();
      await expect(member.page.getByText("customers:read")).toBeVisible();
    } finally {
      await member.cleanup();
    }
  });

  test("server re-checks atoms: member API gets 200 for grants, 403 otherwise", async ({
    page,
    browser,
    request,
  }) => {
    const token = await inviteMember(page, "perm-api@e2e.local", ["models:read"]);
    const origin = new URL(page.url()).origin;
    const member = await loginAsMember(browser, origin, token, "perm_api", "Member-Passw0rd!");

    try {
      const jwt = await memberToken(member.page);
      const auth = { Authorization: `Bearer ${jwt}` };

      const allowed = await request.get("/admin/models", { headers: auth });
      expect(allowed.status(), "models:read → /admin/models 200").toBe(200);

      const deniedProviders = await request.get("/admin/providers", { headers: auth });
      expect(deniedProviders.status(), "no providers:read → 403").toBe(403);

      const deniedCustomers = await request.get("/admin/customers", { headers: auth });
      expect(deniedCustomers.status(), "no customers:read → 403").toBe(403);
    } finally {
      await member.cleanup();
    }
  });

  test("customers:read+balances:read member reads customers but has no write controls", async ({
    page,
    browser,
  }) => {
    // The member joins the admin's current org (Id Org Renamed after the
    // identity test). Create a customer there first so the member has data.
    await createCustomer(page, { name: "Perm Cust Target", email: "perm-cust-target@e2e.local" });

    const token = await inviteMember(page, "perm-cust@e2e.local", [
      "customers:read",
      "balances:read",
    ]);
    const origin = new URL(page.url()).origin;
    const member = await loginAsMember(browser, origin, token, "perm_cust", "Member-Passw0rd!");

    try {
      await expect(member.page.getByRole("link", { name: "Customers" })).toBeVisible();
      await member.page.goto("/customers");
      await expect(member.page.getByRole("heading", { name: "Customers", exact: true })).toBeVisible();
      // balances:read → the Balance column header renders.
      await expect(member.page.getByRole("columnheader", { name: "Balance" })).toBeVisible();
      // No customers:write → the create button is absent (read-only UI).
      await expect(member.page.getByRole("button", { name: "Add Customer" })).toHaveCount(0);
    } finally {
      await member.cleanup();
    }
  });

  test("privilege escalation: a member cannot grant atoms they do not hold", async ({
    page,
    browser,
    request,
  }) => {
    // Member holds invites:write (so it can reach the invite route) + models:read,
    // but NOT customers:write. Granting customers:write must be refused.
    const token = await inviteMember(page, "perm-esc@e2e.local", [
      "invites:write",
      "models:read",
    ]);
    const origin = new URL(page.url()).origin;
    const member = await loginAsMember(browser, origin, token, "perm_esc", "Member-Passw0rd!");

    try {
      const jwt = await memberToken(member.page);
      const res = await request.post("/admin/invites", {
        headers: { Authorization: `Bearer ${jwt}` },
        data: {
          email: "escalation-target@e2e.local",
          role: "member",
          permissions: ["customers:write"],
        },
      });
      expect(res.status(), "granting unheld atom is forbidden").toBe(403);
    } finally {
      await member.cleanup();
    }
  });
});
