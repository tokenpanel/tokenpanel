import {
  expect,
  expectToast,
  reliableClick,
  rowWith,
  selectOption,
  test,
} from "./helpers.ts";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./creds.ts";

/**
 * Identity domain: settings profile email, the full invite → accept flow across
 * two browser contexts, organizations (create / auto-switch / rename), and
 * logout/login.
 *
 * Each test relies on the shared authenticated storage state produced by the
 * `setup` project — no compensating re-login. Two ordering notes:
 *  - The organization test runs after email/invite because creating an org
 *    auto-switches (rebinds) the session to the new org.
 *  - The logout test runs LAST and establishes its OWN fresh session (clearing
 *    the inherited token first), so logging out — which deletes the session
 *    server-side — cannot affect any other test.
 */
test.describe("identity: orgs, settings, invites", () => {
  test("updates the profile email", async ({ page }) => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await reliableClick(page.getByRole("tab", { name: "Profile" }));

    // Login is username-based, so changing the email is harmless to auth.
    const newEmail = `admin+${Date.now()}@e2e.local`;
    await page.locator("#profile-email").fill(newEmail);
    await reliableClick(page.getByRole("button", { name: "Save email" }));
    await expect(page.getByText("Email updated.")).toBeVisible();
  });

  test("creates an invite and accepts it in a separate browser context", async ({
    page,
    browser,
  }) => {
    await page.goto("/settings");
    await reliableClick(page.getByRole("tab", { name: "Invites" }));

    // (a) Admin creates the invite (role Member via the radix Select).
    const inviteEmail = "invitee@id.local";
    await page.locator("#invite-email").fill(inviteEmail);
    await selectOption(page, page.locator("#invite-role"), "Member");
    await reliableClick(page.getByRole("button", { name: "Invite User" }));

    // The one-time reveal alert shows the raw token in a <code> element.
    const reveal = page.locator("[data-slot='alert']", {
      hasText: "Invite created. Share this signup link",
    });
    await expect(reveal).toBeVisible();
    const token = (await reveal.locator("code").first().textContent())?.trim();
    expect(token, "reveal alert shows the invite token").toBeTruthy();

    const origin = new URL(page.url()).origin;

    // (b) A fresh, LOGGED-OUT context accepts the invite. An explicit empty
    // storageState guarantees no inherited admin session (SignupPage redirects
    // authenticated users away from /signup to "/").
    const ctx2 = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const p2 = await ctx2.newPage();
      await p2.goto(`${origin}/signup#/token=${encodeURIComponent(token!)}`);
      await expect(
        p2.getByRole("heading", { name: "Accept your invite" }),
      ).toBeVisible();
      await p2.locator("#invite-username").fill("invitee_user");
      await p2.locator("#invite-password").fill("Invitee-Passw0rd!");
      await p2.locator("#invite-confirm").fill("Invitee-Passw0rd!");
      await reliableClick(p2.getByRole("button", { name: "Accept invite" }));
      // The invitee is now an authenticated member and lands on `/`.
      await p2.waitForURL(/\/$/);
      await expect(p2).toHaveURL(/\/$/);
    } finally {
      await ctx2.close();
    }

    // (c) Back as admin, the invite row now reads `accepted`.
    await page.reload();
    await reliableClick(page.getByRole("tab", { name: "Invites" }));
    await expect(rowWith(page, inviteEmail).getByText("accepted")).toBeVisible();
  });

  test("creates an organization, auto-switches to it, and renames it", async ({
    page,
  }) => {
    await page.goto("/organizations");
    await expect(
      page.getByRole("heading", { name: "Organizations", exact: true }),
    ).toBeVisible();

    const orgCard = (name: string) =>
      page.locator("[data-slot='card']", { has: page.getByText(name, { exact: true }) });

    // Create a new org → it becomes the active org.
    await reliableClick(page.getByRole("button", { name: "New organization" }).first());
    await expect(page.getByRole("heading", { name: "New organization" })).toBeVisible();
    await page.locator("#org-create-name").fill("Id Org");
    await page.locator("#org-create-slug").fill("id-org");
    await reliableClick(page.getByRole("button", { name: "Create", exact: true }));

    // Real success path: the toast confirms creation + auto-switch, and the new
    // org now carries the "Current" badge (no /login bounce).
    await expectToast(page, 'Created "Id Org". Now active.');
    await expect(
      orgCard("Id Org").getByRole("button", { name: "Current", exact: true }),
    ).toBeVisible();

    // Rename it via the per-card actions menu.
    await reliableClick(
      orgCard("Id Org").getByRole("button", { name: "Organization actions" }),
    );
    await reliableClick(page.getByRole("menuitem", { name: "Rename" }));
    await expect(page.getByRole("heading", { name: "Edit organization" })).toBeVisible();
    await page.locator("#org-rename-name").fill("Id Org Renamed");
    await reliableClick(page.getByRole("button", { name: "Save", exact: true }));
    await expectToast(page, "Organization updated.");
    await expect(orgCard("Id Org Renamed")).toBeVisible();

    // The org create auto-switched the session (server-side token rotation).
    // Persist the fresh token so later specs don't inherit a stale one.
    await page.context().storageState({ path: ".auth/state.json" });
  });

  // Runs LAST: logout deletes the session server-side, so nothing may depend on
  // the shared session afterwards. We clear the inherited token and log in fresh
  // to get a clean session to log out of (independent of the org test's rotation).
  test("logs out via the user menu and signs back in", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill(ADMIN_PASSWORD);
    await reliableClick(page.getByRole("button", { name: "Sign in" }));
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await reliableClick(page.getByRole("button", { name: "User menu" }));
    await reliableClick(page.getByRole("menuitem", { name: "Log out" }));
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  });
});
