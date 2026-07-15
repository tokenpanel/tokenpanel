/**
 * Domain API client for analytics summary aggregates.
 */
import { getJson } from "./client.ts";

export type AnalyticsSummary = {
  from: string;
  to: string;
  totals: {
    requests: number;
    tokens: number;
    byCurrency: Array<{
      currency: string;
      requests: number;
      tokens: number;
      costMinor: number;
      priceMinor: number;
    }>;
  };
  topCustomers: Array<{
    customerId: string;
    customerName: string;
    currency: string;
    requests: number;
    tokens: number;
    costMinor: number;
    priceMinor: number;
  }>;
};

export function getAnalyticsSummary(params: {
  from: string;
  to: string;
  top?: number;
}): Promise<AnalyticsSummary> {
  const q = new URLSearchParams({
    from: params.from,
    to: params.to,
    top: String(params.top ?? 50),
  });
  return getJson<AnalyticsSummary>(`/admin/analytics/summary?${q.toString()}`);
}
