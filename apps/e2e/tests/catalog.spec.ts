import {
  test,
  expect,
  reliableClick,
  selectOption,
  acceptNextDialog,
  rowWith,
  createProvider,
  discoverProvider,
  renameProvider,
  toggleProviderActive,
  deleteProvider,
  createModel,
  MOCK_BASE_URL,
  MOCK_API_KEY,
} from "./helpers.ts";

// Unique names so this suite never collides with the other E2E specs that run
// against the same throwaway DB.
const LIFECYCLE_PROVIDER = "Cat Provider";
const RENAMED_PROVIDER = "Cat Provider Renamed";
const MODEL_PROVIDER = "Cat Model Provider";
const MODEL_ALIAS = "cat-model";
const MODEL_NAME = "Cat Model";
const MODEL_NAME_UPDATED = "Cat Model Updated";
const PRIMARY_UPSTREAM = "mock-gpt";
const FALLBACK_UPSTREAM = "mock-gpt-mini";
const META_KEY = "tier";
const META_VALUE = "premium";

test.describe("catalog: providers + models", () => {
  // ---------------------------------------------------------------------------
  // Providers lifecycle (mock-backed so discovery works). These run in order on
  // a single provider: create → discover → rename → disable/re-enable → delete.
  // ---------------------------------------------------------------------------

  test("creates a provider and shows it in the list", async ({ page }) => {
    await createProvider(page, {
      name: LIFECYCLE_PROVIDER,
      baseUrl: MOCK_BASE_URL,
      apiKey: MOCK_API_KEY,
    });
    await expect(page.getByRole("cell", { name: LIFECYCLE_PROVIDER })).toBeVisible();
  });

  test("discovers upstream models and shows them in the cached panel", async ({ page }) => {
    await discoverProvider(page, LIFECYCLE_PROVIDER);

    // Expand the cached-models panel for this provider and confirm a discovered
    // model id from the mock provider is present.
    await reliableClick(rowWith(page, LIFECYCLE_PROVIDER).getByRole("button", { name: "Models" }));
    await expect(page.getByText("Cached Models")).toBeVisible();
    await expect(page.getByRole("cell", { name: PRIMARY_UPSTREAM, exact: true }).first()).toBeVisible();
  });

  test("renames a provider", async ({ page }) => {
    await renameProvider(page, LIFECYCLE_PROVIDER, RENAMED_PROVIDER);
    await expect(page.getByRole("cell", { name: RENAMED_PROVIDER })).toBeVisible();
  });

  test("disables then re-enables a provider", async ({ page }) => {
    // Disable.
    await toggleProviderActive(page, RENAMED_PROVIDER);
    await expect(
      rowWith(page, RENAMED_PROVIDER).getByRole("switch", { name: "Toggle provider active" }),
    ).not.toBeChecked();

    // Re-enable.
    await toggleProviderActive(page, RENAMED_PROVIDER);
    await expect(
      rowWith(page, RENAMED_PROVIDER).getByRole("switch", { name: "Toggle provider active" }),
    ).toBeChecked();
  });

  test("deletes a provider and removes its row", async ({ page }) => {
    await deleteProvider(page, RENAMED_PROVIDER);
    await expect(page.getByRole("cell", { name: RENAMED_PROVIDER })).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Models (backed by a dedicated mock provider so the lifecycle deletion above
  // does not affect them). create → edit name → add fallback entry → metadata →
  // delete.
  // ---------------------------------------------------------------------------

  test("creates a model bound to a mock-backed provider", async ({ page }) => {
    await createProvider(page, {
      name: MODEL_PROVIDER,
      baseUrl: MOCK_BASE_URL,
      apiKey: MOCK_API_KEY,
    });

    await createModel(page, {
      alias: MODEL_ALIAS,
      name: MODEL_NAME,
      providerName: MODEL_PROVIDER,
      upstream: PRIMARY_UPSTREAM,
    });

    await expect(page.getByRole("cell", { name: MODEL_ALIAS })).toBeVisible();
    await expect(page.getByRole("cell", { name: MODEL_NAME })).toBeVisible();
  });

  test("edits the model display name and reflects it in the list", async ({ page }) => {
    await page.goto("/models");
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Edit" }));
    await expect(page.locator("#m-name")).toBeVisible();

    await page.locator("#m-name").fill(MODEL_NAME_UPDATED);
    await reliableClick(page.getByRole("button", { name: "Save", exact: true }));

    await page.goto("/models");
    await expect(page.getByRole("cell", { name: MODEL_NAME_UPDATED })).toBeVisible();
  });

  test("adds a second fallback entry via the edit view", async ({ page }) => {
    await page.goto("/models");
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Edit" }));
    await expect(page.getByText("Fallback chain")).toBeVisible();

    // Open the inline add-entry form.
    await reliableClick(page.getByRole("button", { name: "Add Provider Entry" }));
    await expect(page.locator("#ae-prov")).toBeVisible();

    await selectOption(page, page.locator("#ae-prov"), MODEL_PROVIDER);

    // This provider's catalog is empty (never discovered), so #ae-up renders as
    // a plain text input — fill the upstream id directly (no manual toggle).
    await page.locator("#ae-up").fill(FALLBACK_UPSTREAM);
    await reliableClick(page.getByRole("button", { name: "Add entry" }));

    // Bug #3 fixed: the fallback chain live-refreshes after add, so the new
    // entry appears in place — no re-navigation needed.
    await expect(page.getByText(FALLBACK_UPSTREAM).first()).toBeVisible();
  });

  test("reorders the fallback chain by drag-and-drop", async ({ page }) => {
    await page.goto("/models");
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Edit" }));
    await expect(page.getByText("Fallback chain")).toBeVisible();

    const rows = page.locator("[draggable='true']");
    await expect(rows).toHaveCount(2);

    // Drag the second entry (mock-gpt-mini) onto the first. With the reorder
    // fix (client now PUTs, matching the route) the change persists and the
    // chain re-renders with mock-gpt-mini first.
    await rows.nth(1).dragTo(rows.nth(0));
    await expect(rows.nth(0)).toContainText("mock-gpt-mini");
  });

  test("adds a metadata row, saves, and confirms it persists", async ({ page }) => {
    await page.goto("/models");
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Edit" }));

    await reliableClick(page.getByRole("button", { name: "Add metadata row" }));
    await page.getByLabel("Metadata name 1").fill(META_KEY);
    await page.getByLabel("Metadata value 1").fill(META_VALUE);
    await reliableClick(page.getByRole("button", { name: "Save", exact: true }));

    // Re-open the edit view and confirm the stored metadata row rehydrated.
    await page.goto("/models");
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Edit" }));
    await expect(page.getByLabel("Metadata name 1")).toHaveValue(META_KEY);
    await expect(page.getByLabel("Metadata value 1")).toHaveValue(META_VALUE);
  });

  test("deletes the model via native confirm and removes it from the list", async ({ page }) => {
    await page.goto("/models");

    // Native confirm(): register the accept handler BEFORE triggering delete.
    acceptNextDialog(page);
    await reliableClick(rowWith(page, MODEL_ALIAS).getByRole("button", { name: "Delete" }));

    await expect(page.getByRole("cell", { name: MODEL_ALIAS })).not.toBeVisible();
  });
});
