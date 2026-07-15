/**
 * Domain API client for admin dashboard aggregates.
 */
import { getJson } from "./client.ts";

export type DashboardSummary = {
  customers: number;
  models: number;
  providers: number;
  activePlans: number;
  balancesByCurrency: Record<string, number>;
  recentCustomers: Array<{
    _id: string;
    name: string;
    email: string | null;
    balance: { amountMinor: number; currency: string; reservedMinor?: number };
    status: string;
    createdAt?: string;
  }>;
};

export function getDashboardSummary(): Promise<DashboardSummary> {
  return getJson<DashboardSummary>("/admin/dashboard/summary");
}
