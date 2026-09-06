import { test, expect } from "bun:test";
import { statusVariant, reasonLabel, intervalLabel, subStatusLabel, errorMessage } from "../../customers/labels.ts";
import { ApiError } from "../../../api/client.ts";

test("statusVariant: active/suspended/closed map to badge variants", () => {
  expect(statusVariant("active")).toBe("success");
  expect(statusVariant("suspended")).toBe("warning");
  expect(statusVariant("closed")).toBe("destructive");
});

test("reasonLabel: every ledger reason has a label", () => {
  expect(reasonLabel("topup")).toBe("Top-up");
  expect(reasonLabel("usage_debit")).toBe("Usage");
  expect(reasonLabel("refund")).toBe("Refund");
  expect(reasonLabel("adjustment")).toBe("Adjustment");
  expect(reasonLabel("overage")).toBe("Overage");
});

test("intervalLabel: singular vs plural, all intervals", () => {
  expect(intervalLabel("day", 1)).toBe("per day");
  expect(intervalLabel("week", 1)).toBe("per week");
  expect(intervalLabel("month", 1)).toBe("per month");
  expect(intervalLabel("year", 1)).toBe("per year");
  expect(intervalLabel("day", 3)).toBe("per 3 days");
  expect(intervalLabel("week", 2)).toBe("per 2 weeks");
  expect(intervalLabel("month", 6)).toBe("per 6 months");
  expect(intervalLabel("year", 1)).toBe("per year");
});

test("subStatusLabel: underscores become spaces", () => {
  expect(subStatusLabel("past_due")).toBe("past due");
  expect(subStatusLabel("active")).toBe("active");
  // replace("_") is first-occurrence only — contract statuses carry ≤1 underscore
  expect(subStatusLabel("some_future_status" as never)).toBe("some future_status");
});

test("errorMessage: non-ApiError → fallback", () => {
  expect(errorMessage(new Error("boom"), "Fallback.")).toBe("Fallback.");
  expect(errorMessage(undefined, "Fallback.")).toBe("Fallback.");
});

test("errorMessage: 404 → Not found regardless of message", () => {
  expect(errorMessage(new ApiError(404, "missing", null), "Fallback.")).toBe("Not found.");
});

test("errorMessage: 409 maps known conflict bodies to friendly text", () => {
  expect(
    errorMessage(new ApiError(409, "conflict", { error: "subscription_already_active" }), "F."),
  ).toBe("Already has an active subscription.");
  expect(
    errorMessage(new ApiError(409, "conflict", { error: "duplicate_external_id_or_email" }), "F."),
  ).toBe("External ID or email already in use.");
  expect(errorMessage(new ApiError(409, "conflict", { error: "plan_not_active" }), "F.")).toBe(
    "Selected plan is not active.",
  );
});

test("errorMessage: 409 unknown body → raw message; other statuses → message", () => {
  expect(errorMessage(new ApiError(409, "conflict", { error: "mystery" }), "F.")).toBe("conflict");
  expect(errorMessage(new ApiError(409, "conflict", null), "F.")).toBe("conflict");
  expect(errorMessage(new ApiError(500, "kaboom", null), "F.")).toBe("kaboom");
});
