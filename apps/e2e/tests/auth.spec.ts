import { expect, reliableClick, test } from "./fixtures.ts";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./creds.ts";

/**
 * Login-surface coverage. These tests start from the authenticated storage
 * state, clear the persisted token to simulate sign-out, then exercise the
 * login form directly (valid + invalid credentials).
 */
test.describe("login", () => {
  async function gotoLoggedOutLogin(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  }

  test("signs out and signs back in with valid credentials", async ({ page }) => {
    // Confirms the captured auth state is actually logged in first.
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    await gotoLoggedOutLogin(page);
    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill(ADMIN_PASSWORD);
    await reliableClick(page.getByRole("button", { name: "Sign in" }));

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("rejects an incorrect password", async ({ page }) => {
    await gotoLoggedOutLogin(page);
    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill("not-the-right-password-1!");
    await reliableClick(page.getByRole("button", { name: "Sign in" }));

    await expect(page.getByText("Invalid username or password.")).toBeVisible();
  });
});
