/**
 * Domain API client for /admin/customers and related balance/subscription/usage/keys.
 */
import { deleteJson, getJson, patchJson, postJson } from "./client.ts";
import type { Money } from "./types.ts";

export type CustomerStatus = "active" | "suspended" | "closed";

export type AdminCustomer = {
  _id: string;
  organizationId: string;
  externalId: string | null;
  name: string;
  email: string | null;
  balance: Money;
  status: CustomerStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CustomerListResponse = {
  items: AdminCustomer[];
  total: number;
};

export type BalanceAdjustment = {
  _id: string;
  amountMinor: number;
  currency: string;
  reason: "topup" | "usage_debit" | "refund" | "adjustment" | "overage";
  note?: string | null;
  occurredAt: string;
  createdAt: string;
};

export type PlanSummary = {
  _id: string;
  name: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  price: Money;
  active: boolean;
};

export type Subscription = {
  _id: string;
  planId: string;
  status: "active" | "canceled" | "expired" | "past_due";
  periodStart: string;
  periodEnd: string;
};

export type UsageByModel = {
  model: string;
  requests: number;
  tokens: number;
  costMinor: number;
  priceMinor: number;
};

export type CustomerUsageResponse = {
  totalRequests: number;
  totalTokens: number;
  totalCostMinor: number;
  totalPriceMinor: number;
  currency: string;
  byModel: UsageByModel[];
};

export type CustomerApiKey = {
  _id: string;
  name: string;
  prefix: string;
  status: "active" | "revoked";
  modelWhitelist: string[] | null;
  lastUsedAt?: string | null;
  createdAt: string;
};

export function listCustomers(
  query: Record<string, string>,
): Promise<CustomerListResponse> {
  const params = new URLSearchParams(query);
  return getJson<CustomerListResponse>(`/admin/customers?${params.toString()}`);
}

export function createCustomer(body: unknown): Promise<AdminCustomer> {
  return postJson<AdminCustomer>("/admin/customers", body);
}

export function updateCustomer(
  id: string,
  body: unknown,
): Promise<AdminCustomer> {
  return patchJson<AdminCustomer>(`/admin/customers/${id}`, body);
}

export function deleteCustomer(id: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(`/admin/customers/${id}`);
}

export function getBalanceHistory(
  customerId: string,
): Promise<{ items: BalanceAdjustment[] }> {
  return getJson<{ items: BalanceAdjustment[] }>(
    `/admin/customers/${customerId}/balance`,
  );
}

export function adjustBalance(
  customerId: string,
  body: unknown,
): Promise<{ customer: AdminCustomer; adjustment: BalanceAdjustment }> {
  return postJson(`/admin/customers/${customerId}/balance`, body);
}

export function getSubscription(
  customerId: string,
): Promise<{ subscription: Subscription | null }> {
  return getJson(`/admin/customers/${customerId}/subscription`);
}

export function listPlans(): Promise<{ items: PlanSummary[] }> {
  return getJson<{ items: PlanSummary[] }>("/admin/plans");
}

export function subscribeCustomer(
  customerId: string,
  body: { planId: string },
): Promise<Subscription> {
  return postJson<Subscription>(`/admin/customers/${customerId}/subscribe`, body);
}

export function getCustomerUsage(
  customerId: string,
  query?: string,
): Promise<CustomerUsageResponse> {
  const q = query ? `?${query}` : "";
  return getJson<CustomerUsageResponse>(
    `/admin/customers/${customerId}/usage${q}`,
  );
}

export function listCustomerApiKeys(
  customerId: string,
): Promise<{ items: CustomerApiKey[] }> {
  return getJson<{ items: CustomerApiKey[] }>(
    `/admin/api-keys?customerId=${customerId}`,
  );
}

export function createApiKey(
  body: unknown,
): Promise<{ apiKey: CustomerApiKey; key: string }> {
  return postJson("/admin/api-keys", body);
}

export function revokeApiKey(id: string): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(`/admin/api-keys/${id}`);
}
