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

test("errorMessage: ApiError shows the API's standard message", () => {
  const body = {
    error: {
      code: "subscription_already_active",
      message: "The customer already has an active subscription.",
    },
  };
  const err = new ApiError(409, body.error.message, body);
  expect(err.code).toBe("subscription_already_active");
  expect(errorMessage(err, "F.")).toBe("The customer already has an active subscription.");
});

test("ApiError.fieldErrors: first issue per top-level field", () => {
  const err = new ApiError(400, "Invalid request: password: too short", {
    error: {
      code: "validation_error",
      message: "Invalid request: password: too short",
      details: {
        issues: [
          { path: "password", message: "too short" },
          { path: "password", message: "needs a digit" },
          { path: "entries.0.providerId", message: "Provider not found" },
        ],
      },
    },
  });
  expect(err.fieldErrors()).toEqual({ password: "too short", entries: "Provider not found" });
  expect(new ApiError(500, "x", null).fieldErrors()).toEqual({});
});

test("errorMessage: non-standard bodies → raw message", () => {
  expect(errorMessage(new ApiError(409, "conflict", { error: "mystery" }), "F.")).toBe("conflict");
  expect(errorMessage(new ApiError(409, "conflict", null), "F.")).toBe("conflict");
  expect(errorMessage(new ApiError(500, "kaboom", null), "F.")).toBe("kaboom");
});
