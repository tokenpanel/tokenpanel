import { expect, reliableClick, test } from "./fixtures.ts";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./creds.ts";

const AUTH_STATE = ".auth/state.json";

/**
 * Settings → Profile → Password. Changing the password revokes ALL sessions
 * server-side (including the shared setup session in .auth/state.json) and
 * clears local auth, so the user must sign in again with the NEW password and
 * the OLD one stops working.
 *
 * Because the change invalidates the storage state every other spec depends on,
 * this test is self-healing: it restores the known password AND re-establishes a
 * fresh session, rewriting .auth/state.json so later specs get a valid token no
 * matter where this file falls in the run order.
 */
test.describe("settings: change password", () => {
  test("changes the password, forces re-login, and rejects the old one", async ({
    page,
  }) => {
    const newPassword = "E2E-New-Passw0rd!";

    await page.goto("/settings");
    await reliableClick(page.getByRole("tab", { name: "Profile" }));

    await page.locator("#cur-pw").fill(ADMIN_PASSWORD);
    await page.locator("#new-pw").fill(newPassword);
    await page.locator("#confirm-pw").fill(newPassword);
    await reliableClick(page.getByRole("button", { name: "Change password" }));

    // The session is revoked → the app drops back to the login screen.
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();

    // Old password no longer works.
    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill(ADMIN_PASSWORD);
    await reliableClick(page.getByRole("button", { name: "Sign in" }));
    await expect(page.getByText("Invalid username or password.")).toBeVisible();

    // Reload to clear the error state, then try the new password.
    await page.goto("/login");
    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill(newPassword);
    await reliableClick(page.getByRole("button", { name: "Sign in" }));
    await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();


    // Restore the known password so creds.ts stays valid for future runs.
    await page.goto("/settings");
    await reliableClick(page.getByRole("tab", { name: "Profile" }));
    await page.locator("#cur-pw").fill(newPassword);
    await page.locator("#new-pw").fill(ADMIN_PASSWORD);
    await page.locator("#confirm-pw").fill(ADMIN_PASSWORD);
    await reliableClick(page.getByRole("button", { name: "Change password" }));
    await page.waitForURL(/\/login$/);

    // Re-establish a fresh session with the restored password and overwrite the
    // shared storage state (the old one was revoked by the password changes).
    await page.goto("/login");
    await page.locator("#login-username").fill(ADMIN_USERNAME);
    await page.locator("#login-password").fill(ADMIN_PASSWORD);
    await reliableClick(page.getByRole("button", { name: "Sign in" }));
    await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();

    await page.context().storageState({ path: AUTH_STATE });
  });
});
