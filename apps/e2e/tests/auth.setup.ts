import { test as setup, expect, reliableClick } from "./fixtures.ts";
import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_USERNAME } from "./creds.ts";

const AUTH_STATE = ".auth/state.json";

/**
 * Runs once before the authenticated project. Against the fresh throwaway DB
 * the app is in first-run mode, so we complete signup to create the initial
 * admin, then persist the auth state (JWT in localStorage) for reuse.
 */
setup("first-run signup creates the initial admin", async ({ page }) => {
  await page.goto("/");

  // Fresh database → the SPA redirects to first-run signup.
  await page.waitForURL(/\/signup$/);
  await expect(
    page.getByRole("heading", { name: "Create your admin account" }),
  ).toBeVisible();

  await page.locator("#signup-email").fill(ADMIN_EMAIL);
  await page.locator("#signup-username").fill(ADMIN_USERNAME);
  await page.locator("#signup-password").fill(ADMIN_PASSWORD);
  await page.locator("#signup-confirm").fill(ADMIN_PASSWORD);
  await reliableClick(page.getByRole("button", { name: "Create admin account" }));

  // Lands on the dashboard once signup succeeds and the token is stored.
  await page.waitForURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE });
});
