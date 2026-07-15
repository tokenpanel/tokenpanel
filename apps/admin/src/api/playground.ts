/**
 * Domain API client for Playground bootstrap data.
 */
import { getJson } from "./client.ts";
import type {
  PlaygroundCustomerListResponse,
  PlaygroundModelListResponse,
} from "./types.ts";

export function listPlaygroundModels(): Promise<PlaygroundModelListResponse> {
  return getJson<PlaygroundModelListResponse>("/admin/models");
}

export function listPlaygroundCustomers(
  limit: number,
): Promise<PlaygroundCustomerListResponse> {
  return getJson<PlaygroundCustomerListResponse>(
    `/admin/customers?limit=${limit}`,
  );
}
