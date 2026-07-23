import {
  test,
  expect,
  reliableClick,
  selectOption,
  acceptNextDialog,
  rowWith,
  createCustomer,
  openCustomerDrawer,
  addCustomerCredit,
  createPlan,
  createCustomerApiKey,
  createManagementKey,
} from "./helpers.ts";

// Unique "Acc" names so this suite never collides with the other E2E specs that
// run against the same throwaway DB. Each test provisions its own entities and
// asserts on those specifically (never global counts).
const CUSTOMER = "Acc Customer";
const CUSTOMER_EMAIL = "acc-customer@example.com";
const CUSTOMER_EMAIL_UPDATED = "acc-customer-edited@example.com";

const PLAN_RULE = "Acc Plan Rule";

const SUB_PLAN = "Acc Sub Plan";
const SUB_CUSTOMER = "Acc Sub Customer";
const SUB_CUSTOMER_EMAIL = "acc-sub@example.com";

const CLOSE_CUSTOMER = "Acc Close Customer";
const CLOSE_CUSTOMER_EMAIL = "acc-close@example.com";

const KEY_CUSTOMER = "Acc Key Customer";
const KEY_CUSTOMER_EMAIL = "acc-key@example.com";
const API_KEY_NAME = "Acc Live Key";

const MGMT_KEY = "Acc Mgmt Key";
const MGMT_KEY_RENAMED = "Acc Mgmt Key Renamed";

test.describe("access: customers, plans, keys", () => {
  test("creates a customer, edits its email, and adds credit", async ({ page }) => {
    // createCustomer leaves the auto-opened detail drawer visible.
    await createCustomer(page, { name: CUSTOMER, email: CUSTOMER_EMAIL });
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText(CUSTOMER).first()).toBeVisible();

    // Edit the email via the drawer's Edit dialog. Opening it puts a second
    // role="dialog" (the modal) over the Sheet drawer, so scope by its heading.
    await reliableClick(drawer.getByRole("button", { name: "Edit", exact: true }));
    const editModal = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "Edit customer" }) });
    await expect(editModal).toBeVisible();
    await editModal.locator("#cust-email").fill(CUSTOMER_EMAIL_UPDATED);
    await reliableClick(editModal.getByRole("button", { name: "Save", exact: true }));

    // Once the modal closes the drawer (the only remaining dialog) shows the
    // updated email in the Customer info grid.
    await expect(page.getByRole("heading", { name: "Edit customer" })).not.toBeVisible();
    await expect(
      page.getByRole("dialog").getByText(CUSTOMER_EMAIL_UPDATED).first(),
    ).toBeVisible();

    // Add credit on the open drawer; a Top-up ledger entry appears.
    await addCustomerCredit(page, { amount: "2500", currency: "USD" });
  });

  test("creates a plan with a rate-limit rule, then deactivates it", async ({ page }) => {
    // Build the plan inline (createPlan submits immediately and can't add a
    // rule), mirroring its field fills and inserting one rate-limit rule.
    await page.goto("/plans");
    await reliableClick(page.getByRole("button", { name: "Add Plan" }).first());
    await expect(page.getByRole("heading", { name: "New plan" })).toBeVisible();

    await page.locator("#plan-name").fill(PLAN_RULE);
    await selectOption(page, page.locator("#plan-interval"), "month");
    await page.locator("#plan-interval-count").fill("1");
    await page.locator("#plan-price-amount").fill("2000");
    await page.locator("#plan-price-currency").fill("USD");
    await page.locator("#plan-credit-amount").fill("5000");
    await page.locator("#plan-credit-currency").fill("USD");
    await page.locator("#plan-tokens").fill("100000");

    // One rule: 1h window (preset), requests dimension, 500 cap, customer scope.
    await reliableClick(page.getByRole("button", { name: "Add Rule" }));
    await reliableClick(page.getByRole("button", { name: "1h", exact: true }));
    await selectOption(page, page.locator("[id^='rule-dim-']"), "requests");
    // The cap input carries no id; reach it via its dimension-dependent label.
    await page
      .getByText("max requests", { exact: true })
      .locator("xpath=following-sibling::input[1]")
      .fill("500");
    await selectOption(page, page.locator("[id^='rule-scope-']"), "customer");

    await reliableClick(page.getByRole("button", { name: "Create plan" }));

    // The plan card shows active plus the saved rule summary line.
    const card = page
      .locator("div.flex.flex-col.gap-3.p-5")
      .filter({ has: page.getByRole("heading", { name: PLAN_RULE, exact: true }) });
    await expect(card).toBeVisible();
    await expect(card.getByText("active", { exact: true })).toBeVisible();
    await expect(
      card.locator("li").filter({ hasText: "customer scope" }),
    ).toHaveText(/1h.*max 500 requests.*customer scope/);

    // Deactivate (soft delete) via native confirm; the badge flips to inactive
    // while the card stays in the grid.
    acceptNextDialog(page);
    await reliableClick(card.getByRole("button", { name: "Delete" }));
    await expect(card.getByText("inactive", { exact: true })).toBeVisible();
  });

  test("assigns an active plan to a customer subscription", async ({ page }) => {
    // A plan must be ACTIVE to be assignable — create a dedicated one and leave
    // it active (the rule plan above is deactivated by its own test).
    await createPlan(page, { name: SUB_PLAN, price: "1500" });

    // New customer; its drawer auto-opens with the Subscription card.
    await createCustomer(page, { name: SUB_CUSTOMER, email: SUB_CUSTOMER_EMAIL });

    // The subscription form's Select trigger is the combobox sibling of Assign.
    const subForm = page.locator("form", { has: page.getByRole("button", { name: "Assign" }) });
    await selectOption(page, subForm.getByRole("combobox"), new RegExp(SUB_PLAN));
    await reliableClick(subForm.getByRole("button", { name: "Assign" }));

    // The placeholder form is replaced by the subscription details (plan name).
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("No active subscription.")).not.toBeVisible();
    await expect(drawer.getByText(SUB_PLAN).first()).toBeVisible();
  });

  test("closes a customer and shows closed status on reopen", async ({ page }) => {
    await createCustomer(page, { name: CLOSE_CUSTOMER, email: CLOSE_CUSTOMER_EMAIL });

    // The drawer has two "Close" buttons (the Sheet header one just dismisses
    // the drawer); scope to the Customer-info button group that also holds Edit
    // to hit the destructive close that triggers the native confirm.
    acceptNextDialog(page);
    await reliableClick(
      page
        .getByRole("dialog")
        .locator("div.flex.gap-2", {
          has: page.getByRole("button", { name: "Edit", exact: true }),
        })
        .getByRole("button", { name: "Close", exact: true }),
    );

    // Wait for the drawer to close — it only dismisses after the close request
    // completes, so the status is persisted before we reload the list.
    await expect(page.getByRole("dialog")).not.toBeVisible();

    await openCustomerDrawer(page, CLOSE_CUSTOMER);
    await expect(
      page.getByRole("dialog").getByText("closed", { exact: true }).first(),
    ).toBeVisible();
  });

  test("creates a customer API key, then revokes it", async ({ page }) => {
    // A key needs a customer; provision one dedicated to this test.
    await createCustomer(page, { name: KEY_CUSTOMER, email: KEY_CUSTOMER_EMAIL });

    const key = await createCustomerApiKey(page, {
      customerName: KEY_CUSTOMER,
      keyName: API_KEY_NAME,
    });
    expect(key).toContain("tp_live_");

    // The new key is listed as active; revoke it via native confirm and the
    // status badge flips to revoked (the row stays).
    const row = rowWith(page, API_KEY_NAME);
    await expect(row).toBeVisible();
    acceptNextDialog(page);
    await reliableClick(row.getByRole("button", { name: "Revoke" }));
    await expect(row.getByRole("cell", { name: "revoked" })).toBeVisible();
  });

  test("creates, renames, and revokes a management key", async ({ page }) => {
    const key = await createManagementKey(page, MGMT_KEY);
    expect(key).toContain("tp_mgmt_");

    // The default scopes (models:read, customers:read) show on the row.
    const row = rowWith(page, MGMT_KEY);
    await expect(row).toBeVisible();
    await expect(row.getByText("models:read").first()).toBeVisible();

    // Rename via the inline edit form.
    await reliableClick(row.getByRole("button", { name: "Edit" }));
    await expect(page.getByRole("heading", { name: "Edit management key" })).toBeVisible();
    await page.locator("#mgmt-name").fill(MGMT_KEY_RENAMED);
    await reliableClick(page.getByRole("button", { name: "Save changes" }));
    await expect(page.getByRole("cell", { name: MGMT_KEY_RENAMED })).toBeVisible();

    // Revoke via native confirm; the badge flips to revoked.
    const renamedRow = rowWith(page, MGMT_KEY_RENAMED);
    acceptNextDialog(page);
    await reliableClick(renamedRow.getByRole("button", { name: "Revoke" }));
    await expect(renamedRow.getByRole("cell", { name: "revoked" })).toBeVisible();
  });
});
