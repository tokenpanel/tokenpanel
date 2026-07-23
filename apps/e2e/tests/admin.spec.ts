import { expect, reliableClick, test } from "./fixtures.ts";

/**
 * Authenticated admin-console flows: the dashboard renders, the main sections
 * load, and a provider can be created from a preset (exercises the Add Provider
 * dialog end to end).
 */
test.describe("admin console (authenticated)", () => {
  test("dashboard loads on a fresh instance", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Recent customers")).toBeVisible();
  });

  test("main sections load via direct navigation", async ({ page }) => {
    const sections = [
      ["/providers", "Providers"],
      ["/models", "Models"],
      ["/customers", "Customers"],
      ["/plans", "Plans"],
    ] as const;

    for (const [path, title] of sections) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }
  });

  test("creates a provider from a preset", async ({ page }) => {
    await page.goto("/providers");
    await expect(page.getByText("No providers yet")).toBeVisible();

    // Empty state + header both render "Add Provider"; the header one is first.
    await reliableClick(page.getByRole("button", { name: "Add Provider" }).first());
    await expect(page.getByRole("heading", { name: "Add Provider" })).toBeVisible();

    // Selecting the OpenAI preset autofills the adapter + base URL.
    await reliableClick(page.locator("#prov-preset"));
    const openai = page.getByRole("option", { name: "OpenAI", exact: true });
    await expect(openai).toBeVisible();
    await openai.click({ force: true });
    await expect(page.locator("#prov-url")).toHaveValue("https://api.openai.com/v1");

    await page.locator("#prov-name").fill("E2E OpenAI");
    await page.locator("#prov-key").fill("sk-e2e-test-0123456789abcdef");
    await reliableClick(page.getByRole("button", { name: "Create provider" }));

    // Dialog closes and the new provider appears in the table.
    await expect(page.getByRole("cell", { name: "E2E OpenAI" })).toBeVisible();
  });
});
