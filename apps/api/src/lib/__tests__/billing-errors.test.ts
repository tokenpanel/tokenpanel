import { test, expect } from "bun:test";
import { billingAppError, throwBilling } from "../billing-errors.ts";
import {
  AuthorizationError,
  InsufficientBalanceError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SystemError,
  ValidationError,
} from "../../errors/families.ts";
import type { ProviderErrorPhase } from "../../errors/variants.ts";

test("billingAppError: model_not_found maps to NotFoundError with resource=model", () => {
  const err = billingAppError(404, "model_not_found", "gpt-x is unknown");
  expect(err).toBeInstanceOf(NotFoundError);
  if (!(err instanceof NotFoundError)) throw new Error("unreachable");
  expect(err._tag).toBe("NotFoundError");
  expect(err.code).toBe("model_not_found");
  expect(err.message).toBe("gpt-x is unknown");
  expect(err.resource).toBe("model");
});

test("billingAppError: model_not_allowed and customer_not_found map to AuthorizationError keeping the code", () => {
  const notAllowed = billingAppError(403, "model_not_allowed", "blocked");
  expect(notAllowed).toBeInstanceOf(AuthorizationError);
  if (!(notAllowed instanceof AuthorizationError)) throw new Error("unreachable");
  expect(notAllowed.code).toBe("model_not_allowed");
  expect(notAllowed.message).toBe("blocked");

  const customerMissing = billingAppError(403, "customer_not_found", "no such customer");
  expect(customerMissing).toBeInstanceOf(AuthorizationError);
  if (!(customerMissing instanceof AuthorizationError)) throw new Error("unreachable");
  expect(customerMissing.code).toBe("customer_not_found");
});

test("billingAppError: customer_inactive maps to AuthorizationError forbidden with reason", () => {
  const err = billingAppError(403, "customer_inactive", "account suspended");
  expect(err).toBeInstanceOf(AuthorizationError);
  if (!(err instanceof AuthorizationError)) throw new Error("unreachable");
  expect(err.code).toBe("forbidden");
  expect(err.reason).toBe("customer_inactive");
  expect(err.message).toBe("account suspended");
});

test("billingAppError: invalid_customer_id maps to a default-400 ValidationError", () => {
  const err = billingAppError(400, "invalid_customer_id", "bad id");
  expect(err).toBeInstanceOf(ValidationError);
  if (!(err instanceof ValidationError)) throw new Error("unreachable");
  expect(err.code).toBe("validation_error");
  expect(err.mode).toBe("default_400");
});

test("billingAppError: insufficient_balance preserves amount fields", () => {
  const err = billingAppError(402, "insufficient_balance", "top up required", {
    balanceMicros: 5_000_000,
    requiredMicros: 12_500_000,
    currency: "USD",
  });
  expect(err).toBeInstanceOf(InsufficientBalanceError);
  if (!(err instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(err.code).toBe("insufficient_balance");
  expect(err.message).toBe("top up required");
  expect(err.balanceMicros).toBe(5_000_000);
  expect(err.requiredMicros).toBe(12_500_000);
  expect(err.currency).toBe("USD");
});

test("billingAppError: insufficient_balance without extra leaves amount fields undefined", () => {
  const err = billingAppError(402, "insufficient_balance", "broke");
  expect(err).toBeInstanceOf(InsufficientBalanceError);
  if (!(err instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(err.balanceMicros).toBeUndefined();
  expect(err.requiredMicros).toBeUndefined();
  expect(err.currency).toBeUndefined();
});

test("billingAppError: insufficient_balance accepts legacy unit extras with micros taking precedence", () => {
  const legacy = billingAppError(402, "insufficient_balance", "legacy", {
    balanceUnits: 2,
    requiredUnits: 7,
  });
  if (!(legacy instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(legacy.balanceMicros).toBe(2);
  expect(legacy.requiredMicros).toBe(7);

  const available = billingAppError(402, "insufficient_balance", "available", {
    availableUnits: 9,
  });
  if (!(available instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(available.balanceMicros).toBe(9);

  const precedence = billingAppError(402, "insufficient_balance", "both", {
    balanceMicros: 100,
    balanceUnits: 999,
  });
  if (!(precedence instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(precedence.balanceMicros).toBe(100);
});

test("billingAppError: currency_mismatch preserves both currencies", () => {
  const err = billingAppError(402, "currency_mismatch", "wrong currency", {
    balanceCurrency: "USD",
    modelCurrency: "EUR",
  });
  expect(err).toBeInstanceOf(InsufficientBalanceError);
  if (!(err instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(err.code).toBe("currency_mismatch");
  expect(err.balanceCurrency).toBe("USD");
  expect(err.modelCurrency).toBe("EUR");
});

test("billingAppError: rate_limited defaults retryAfterSeconds to 1 and keeps window fields", () => {
  const bare = billingAppError(429, "rate_limited", "slow down");
  expect(bare).toBeInstanceOf(RateLimitExceededError);
  if (!(bare instanceof RateLimitExceededError)) throw new Error("unreachable");
  expect(bare.retryAfterSeconds).toBe(1);
  expect(bare.dimension).toBeUndefined();

  const full = billingAppError(429, "rate_limited", "slow down", {
    retryAfterSeconds: 30,
    dimension: "requests_per_minute",
    cap: 60,
    current: 61,
    windowSeconds: 60,
  });
  if (!(full instanceof RateLimitExceededError)) throw new Error("unreachable");
  expect(full.retryAfterSeconds).toBe(30);
  expect(full.dimension).toBe("requests_per_minute");
  expect(full.cap).toBe(60);
  expect(full.current).toBe(61);
  expect(full.windowSeconds).toBe(60);
});

test("billingAppError: provider_error is normalized to ProviderUnavailableError provider_unavailable", () => {
  const err = billingAppError(502, "provider_error", "upstream blew up", {
    category: "http_502",
  });
  expect(err).toBeInstanceOf(ProviderUnavailableError);
  if (!(err instanceof ProviderUnavailableError)) throw new Error("unreachable");
  expect(err.code).toBe("provider_unavailable");
  expect(err.httpStatus).toBe(502);
  expect(err.category).toBe("http_5xx");
  expect(err.diagnostic).toBe("http_502");
  expect(err.phase).toBe("pre_commit" as ProviderErrorPhase);
  expect(err.retryClass).toBe("never");
  expect(err.fallbackClass).toBe("ineligible");
  expect(err.acceptanceClass).toBe("not_accepted");
  expect(err.streamCommitClass).toBe("not_committed");
});

test("billingAppError: infrastructure-style provider codes are categorized as validation", () => {
  for (const code of ["no_active_entries", "adapter_missing"] as const) {
    const err = billingAppError(422, code, "misconfigured");
    if (!(err instanceof ProviderUnavailableError)) throw new Error("unreachable");
    expect(err.code).toBe(code);
    expect(err.category).toBe("validation");
    expect(err.httpStatus).toBe(422);
  }
});

test("billingAppError: unknown codes fall back to SystemError with a billing diagnostic", () => {
  const err = billingAppError(418, "mystery_code", "unexpected");
  expect(err).toBeInstanceOf(SystemError);
  if (!(err instanceof SystemError)) throw new Error("unreachable");
  expect(err.code).toBe("system_error");
  expect(err.message).toBe("unexpected");
  expect(err.diagnostic).toBe("billing_code=mystery_code status=418");
});

test("throwBilling throws the mapped error with fields intact", () => {
  let caught: unknown;
  try {
    throwBilling(402, "insufficient_balance", "balance too low", {
      balanceMicros: 100,
      requiredMicros: 900,
      currency: "EUR",
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InsufficientBalanceError);
  if (!(caught instanceof InsufficientBalanceError)) throw new Error("unreachable");
  expect(caught.message).toBe("balance too low");
  expect(caught.balanceMicros).toBe(100);
  expect(caught.requiredMicros).toBe(900);
  expect(caught.currency).toBe("EUR");

  expect(() => throwBilling(404, "model_not_found", "nope")).toThrow(
    NotFoundError,
  );
  expect(() =>
    throwBilling(429, "rate_limited", "limited", { retryAfterSeconds: 5 }),
  ).toThrow(RateLimitExceededError);
});
