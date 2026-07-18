/**
 * Domain API client for admin dashboard aggregates.
 */
import { getJson } from "./client.ts";

export type DashboardSummary = {
  customers: number;
  models: number;
  providers: number;
  activePlans: number;
  /** Empty when caller lacks balances:read. */
  balancesByCurrency: Record<string, number>;
  recentCustomers: Array<{
    _id: string;
    /** Redacted when caller lacks customers:read. */
    name?: string;
    /** Redacted when caller lacks customers:read. */
    email?: string | null;
    /** Redacted when caller lacks balances:read. */
    balance?: { amountUnits: number; currency: string; reservedUnits?: number };
    status: string;
    /** Redacted when caller lacks customers:read. */
    createdAt?: string;
  }>;
};

export function getDashboardSummary(): Promise<DashboardSummary> {
  return getJson<DashboardSummary>("/admin/dashboard/summary");
}
