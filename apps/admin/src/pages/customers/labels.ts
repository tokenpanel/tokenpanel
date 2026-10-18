/**
 * Pure customer UI labels (domain split from CustomersPage).
 * Enum authority: @tokenpanel/contracts.
 */
import type {
  BalanceAdjustmentReason,
  CustomerStatus,
  PlanInterval,
  SubscriptionStatus,
} from "@tokenpanel/contracts";
import { ApiError } from "../../api/client.ts";

export type {
  CustomerStatus,
  BalanceAdjustmentReason as BalanceReason,
  PlanInterval,
  SubscriptionStatus,
};

export function statusVariant(
  status: CustomerStatus,
): "success" | "warning" | "destructive" {
  switch (status) {
    case "active":
      return "success";
    case "suspended":
      return "warning";
    case "closed":
      return "destructive";
  }
}

export function reasonLabel(reason: BalanceAdjustmentReason): string {
  switch (reason) {
    case "topup":
      return "Top-up";
    case "usage_debit":
      return "Usage";
    case "refund":
      return "Refund";
    case "adjustment":
      return "Adjustment";
    case "overage":
      return "Overage";
  }
}

export function intervalLabel(interval: PlanInterval, count: number): string {
  const unit =
    interval === "day"
      ? "day"
      : interval === "week"
        ? "week"
        : interval === "month"
          ? "month"
          : "year";
  return count === 1 ? `per ${unit}` : `per ${count} ${unit}s`;
}

export function subStatusLabel(status: SubscriptionStatus | string): string {
  return status.replace("_", " ");
}

export function errorMessage(err: unknown, fallback: string): string {
  // The API's standard error message is written for people already.
  if (err instanceof ApiError) return err.message;
  return fallback;
}
