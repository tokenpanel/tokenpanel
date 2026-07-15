import { z } from "zod";

/**
 * Management API key scopes — single live descriptor source.
 *
 * Policy version: 2026-07-13
 * Values are stable public contract: changing a value is a breaking API change.
 * DB enum, API metadata endpoint, and admin UI all derive from this tuple.
 */

export const MANAGEMENT_SCOPE_DEFINITIONS = [
  {
    value: "models:read",
    group: "Models",
    description: "List models and read capabilities / pricing.",
  },
  {
    value: "customers:read",
    group: "Customers",
    description: "Look up customers by email and read their details.",
  },
  {
    value: "customers:write",
    group: "Customers",
    description: "Create / update / suspend / reactivate customers.",
  },
  {
    value: "balances:read",
    group: "Balances",
    description: "Read customer balance and ledger history.",
  },
  {
    value: "balances:write",
    group: "Balances",
    description: "Top up / adjust / refund customer balances.",
  },
  {
    value: "usage:read",
    group: "Usage",
    description: "Read per-customer usage summaries.",
  },
  {
    value: "plans:read",
    group: "Plans",
    description: "List subscription plans.",
  },
  {
    value: "subscriptions:write",
    group: "Plans",
    description: "Assign / change a customer's subscription plan.",
  },
  {
    value: "chat:write",
    group: "Chat",
    description: "Call /v1/chat/completions and /v1/messages.",
  },
] as const;

export type ManagementScopeDefinition =
  (typeof MANAGEMENT_SCOPE_DEFINITIONS)[number];

export type ManagementScope = ManagementScopeDefinition["value"];

export const MANAGEMENT_SCOPES: readonly ManagementScope[] =
  MANAGEMENT_SCOPE_DEFINITIONS.map((d) => d.value);

/** Zod enum over all scope values (tuple must be non-empty for z.enum). */
export const managementScopeSchema = z.enum(
  MANAGEMENT_SCOPES as unknown as [ManagementScope, ...ManagementScope[]],
);

/** API `/__scopes/meta` item shape (scope field name matches historical response). */
export type ManagementScopeMeta = {
  scope: ManagementScope;
  group: string;
  description: string;
};

export const MANAGEMENT_SCOPES_META: readonly ManagementScopeMeta[] =
  MANAGEMENT_SCOPE_DEFINITIONS.map((d) => ({
    scope: d.value,
    group: d.group,
    description: d.description,
  }));
