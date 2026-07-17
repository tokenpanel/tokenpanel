/**
 * Map legacy billing status/code pairs to canonical AppError tags (task 11.3).
 * Prefer throwing these instead of BillingError.
 */
import {
  AuthorizationError,
  InsufficientBalanceError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SystemError,
  ValidationError,
  type AppError,
} from "../errors/families.ts";
import type {
  FallbackClass,
  AcceptanceClass,
  StreamCommitClass,
  RetryClass,
  ProviderErrorCategory,
  ProviderErrorPhase,
} from "../errors/variants.ts";

const defaultProviderMeta = {
  category: "unknown" as ProviderErrorCategory,
  phase: "pre_commit" as ProviderErrorPhase,
  retryClass: "never" as RetryClass,
  fallbackClass: "ineligible" as FallbackClass,
  acceptanceClass: "not_accepted" as AcceptanceClass,
  streamCommitClass: "not_committed" as StreamCommitClass,
};

function num(extra: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = extra?.[key];
  return typeof v === "number" ? v : undefined;
}

function str(extra: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = extra?.[key];
  return typeof v === "string" ? v : undefined;
}

export function billingAppError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown> | undefined,
): AppError {
  switch (code) {
    case "model_not_found":
      return new NotFoundError({ code, message, resource: "model" });
    case "model_not_allowed":
    case "customer_not_found":
      return new AuthorizationError({
        code: code as "model_not_allowed" | "customer_not_found",
        message,
      });
    case "customer_inactive":
      return new AuthorizationError({
        code: "forbidden",
        message,
        reason: code,
      });
    case "invalid_customer_id":
      return new ValidationError({
        code: "validation_error",
        message,
        mode: "default_400",
      });
    case "insufficient_balance": {
      const balanceMinor = num(extra, "balanceMinor") ?? num(extra, "availableMinor");
      const requiredMinor = num(extra, "requiredMinor");
      const currency = str(extra, "currency");
      return new InsufficientBalanceError({
        code: "insufficient_balance",
        message,
        ...(balanceMinor !== undefined ? { balanceMinor } : {}),
        ...(requiredMinor !== undefined ? { requiredMinor } : {}),
        ...(currency !== undefined ? { currency } : {}),
      });
    }
    case "currency_mismatch": {
      const balanceCurrency = str(extra, "balanceCurrency");
      const modelCurrency = str(extra, "modelCurrency");
      return new InsufficientBalanceError({
        code: "currency_mismatch",
        message,
        ...(balanceCurrency !== undefined ? { balanceCurrency } : {}),
        ...(modelCurrency !== undefined ? { modelCurrency } : {}),
      });
    }
    case "rate_limited": {
      const dimension = str(extra, "dimension");
      const cap = num(extra, "cap");
      const current = num(extra, "current");
      const windowSeconds = num(extra, "windowSeconds");
      return new RateLimitExceededError({
        code: "rate_limited",
        message,
        retryAfterSeconds: num(extra, "retryAfterSeconds") ?? 1,
        ...(dimension !== undefined ? { dimension } : {}),
        ...(cap !== undefined ? { cap } : {}),
        ...(current !== undefined ? { current } : {}),
        ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      });
    }
    case "provider_unavailable":
    case "all_providers_failed":
    case "no_active_entries":
    case "adapter_missing":
    case "provider_error": {
      const mappedCode =
        code === "provider_error"
          ? ("provider_unavailable" as const)
          : (code as
              | "provider_unavailable"
              | "all_providers_failed"
              | "no_active_entries"
              | "adapter_missing");
      const diagnostic = str(extra, "category");
      return new ProviderUnavailableError({
        ...defaultProviderMeta,
        code: mappedCode,
        message,
        httpStatus: status,
        category:
          code === "no_active_entries" || code === "adapter_missing"
            ? "validation"
            : "http_5xx",
        ...(diagnostic !== undefined ? { diagnostic } : {}),
      });
    }
    default:
      return new SystemError({
        code: "system_error",
        message,
        diagnostic: `billing_code=${code} status=${status}`,
      });
  }
}

export function throwBilling(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown> | undefined,
): never {
  throw billingAppError(status, code, message, extra);
}
