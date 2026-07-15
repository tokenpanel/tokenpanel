/**
 * Pure customer UI labels (domain split from CustomersPage).
 */
import { ApiError } from "../../api/client.ts";

export type CustomerStatus = "active" | "suspended" | "closed";

export type BalanceReason =
  | "topup"
  | "usage_debit"
  | "refund"
  | "adjustment"
  | "overage";

export type PlanInterval = "day" | "week" | "month" | "year";

export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "expired"
  | "past_due"
  | "ended";

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

export function reasonLabel(reason: BalanceReason): string {
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

export function subStatusLabel(status: SubscriptionStatus): string {
  return status.replace("_", " ");
}

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      const body = err.body as { error?: string } | null;
      if (body?.error === "subscription_already_active") {
        return "Already has an active subscription.";
      }
      if (body?.error === "duplicate_external_id_or_email") {
        return "External ID or email already in use.";
      }
      if (body?.error === "plan_not_active") {
        return "Selected plan is not active.";
      }
      return err.message;
    }
    if (err.status === 404) return "Not found.";
    return err.message;
  }
  return fallback;
}
