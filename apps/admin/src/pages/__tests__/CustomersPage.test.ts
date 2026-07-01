import { test, expect } from "bun:test";
import {
  statusVariant,
  reasonLabel,
  intervalLabel,
  subStatusLabel,
  errorMessage,
} from "../CustomersPage.tsx";
import { ApiError } from "../../api/client.ts";

test("statusVariant: active→success, suspended→warning, closed→destructive", () => {
  expect(statusVariant("active")).toBe("success");
  expect(statusVariant("suspended")).toBe("warning");
  expect(statusVariant("closed")).toBe("destructive");
});

test("reasonLabel: maps all reasons", () => {
  expect(reasonLabel("topup")).toBe("Top-up");
  expect(reasonLabel("usage_debit")).toBe("Usage");
  expect(reasonLabel("refund")).toBe("Refund");
  expect(reasonLabel("adjustment")).toBe("Adjustment");
  expect(reasonLabel("overage")).toBe("Overage");
});

test("intervalLabel: singular vs plural", () => {
  expect(intervalLabel("day", 1)).toBe("per day");
  expect(intervalLabel("day", 2)).toBe("per 2 days");
  expect(intervalLabel("week", 1)).toBe("per week");
  expect(intervalLabel("week", 3)).toBe("per 3 weeks");
  expect(intervalLabel("month", 1)).toBe("per month");
  expect(intervalLabel("month", 6)).toBe("per 6 months");
  expect(intervalLabel("year", 1)).toBe("per year");
  expect(intervalLabel("year", 2)).toBe("per 2 years");
});

test("subStatusLabel: replaces _ with space", () => {
  expect(subStatusLabel("past_due")).toBe("past due");
  expect(subStatusLabel("active")).toBe("active");
  expect(subStatusLabel("trialing")).toBe("trialing");
});

test("errorMessage: 409 subscription_already_active → specific message", () => {
  const e = new ApiError(409, "x", { error: "subscription_already_active" });
  expect(errorMessage(e, "fallback")).toBe("Already has an active subscription.");
});

test("errorMessage: 409 duplicate_external_id_or_email → specific message", () => {
  const e = new ApiError(409, "x", { error: "duplicate_external_id_or_email" });
  expect(errorMessage(e, "fallback")).toBe("External ID or email already in use.");
});

test("errorMessage: 409 plan_not_active → specific message", () => {
  const e = new ApiError(409, "x", { error: "plan_not_active" });
  expect(errorMessage(e, "fallback")).toBe("Selected plan is not active.");
});

test("errorMessage: 409 unknown error code → falls back to err.message", () => {
  const e = new ApiError(409, "some message", { error: "other" });
  expect(errorMessage(e, "fallback")).toBe("some message");
});

test("errorMessage: 404 → 'Not found.'", () => {
  const e = new ApiError(404, "x", {});
  expect(errorMessage(e, "fallback")).toBe("Not found.");
});

test("errorMessage: other status → err.message", () => {
  const e = new ApiError(500, "server error", {});
  expect(errorMessage(e, "fallback")).toBe("server error");
});

test("errorMessage: non-ApiError → fallback string", () => {
  expect(errorMessage(new Error("boom"), "fallback")).toBe("fallback");
});