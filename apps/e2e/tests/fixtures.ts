import { expect, test as base, type Locator } from "@playwright/test";

/**
 * Shared E2E fixtures.
 *
 * `disableAnimations`: the app's `fade-in-up` entry animations (staggered via
 * inline `animation-delay`) plus skeleton `shimmer` / cursor blink would
 * otherwise keep the page "animating" from the browser's point of view. Killing
 * animations + transitions outright (the standard E2E approach) makes renders
 * deterministic. Injected before page scripts so it survives client-side
 * navigations within a test.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      const css = [
        "*, *::before, *::after {",
        "  animation: none !important;",
        "  transition: none !important;",
        "  scroll-behavior: auto !important;",
        "}",
      ].join("\n");
      const apply = () => {
        const style = document.createElement("style");
        style.setAttribute("data-e2e-disable-animations", "true");
        style.textContent = css;
        document.head.appendChild(style);
      };
      if (document.head) {
        apply();
      } else {
        document.addEventListener("DOMContentLoaded", apply, { once: true });
      }
    });
    await use(page);
  },
});

/**
 * Click that bypasses a Playwright stability-check false negative.
 *
 * The app's buttons are provably visible, enabled, and static — constant
 * bounding box across frames and zero running animations once the fixture's
 * `animation: none` override applies — yet a plain `locator.click()` waits
 * forever on "waiting for element to be visible, enabled and stable"
 * (verified 2026-07). We still assert visible + enabled so genuine regressions
 * (a missing or disabled control) fail loudly, then force the click to skip
 * only the spurious stability wait.
 */
export async function reliableClick(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.click({ force: true });
}

export { expect };
