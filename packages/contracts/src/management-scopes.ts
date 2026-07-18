/**
 * Management API key scopes — single live descriptor source.
 *
 * Policy version: 2026-07-13
 * Values are stable public contract: changing a value is a breaking API change.
 * DB enum and admin UI all derive from this tuple.
 *
 * Effect Schema: `managementScopeSchema` (canonical §11 path).
 */
import { Schema } from "effect";
import { withParseApi } from "./parse.ts";
import { hasPanelPermission, type PanelPermission } from "./panel-permissions.ts";

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

/** Effect Schema enum over all scope values (non-empty tuple for Literal). */
const scopeLiterals = MANAGEMENT_SCOPES as unknown as [
  ManagementScope,
  ...ManagementScope[],
];
export const managementScopeSchema = withParseApi(
  Schema.Literal(...scopeLiterals),
);

/**
 * Maps each management scope to the panel permission an actor must hold to
 * grant it on a management API key. Prevents lateral privilege escalation:
 * a member with only `management_keys:write` cannot mint a key carrying
 * `balances:write` unless they also hold `balances:write` themselves.
 *
 * `chat:write` maps to `playground:write` — the closest panel equivalent
 * (both consume provider capacity via chat completions).
 */
const SCOPE_REQUIRED_PANEL_PERMISSION: Readonly<
  Record<ManagementScope, PanelPermission>
> = {
  "models:read": "models:read",
  "customers:read": "customers:read",
  "customers:write": "customers:write",
  "balances:read": "balances:read",
  "balances:write": "balances:write",
  "usage:read": "usage:read",
  "plans:read": "plans:read",
  "subscriptions:write": "subscriptions:write",
  "chat:write": "playground:write",
};

export function requiredPanelPermissionForScope(
  scope: ManagementScope,
): PanelPermission {
  return SCOPE_REQUIRED_PANEL_PERMISSION[scope];
}

/**
 * Whether an actor may grant the given management scopes on a management
 * API key. Mirrors `canGrantPanelAccess` for invites: every scope's
 * required panel permission must be held by the actor (admin role passes
 * all; write implies read via `hasPanelPermission`).
 */
export function canGrantManagementScopes(
  actorRole: "admin" | "member",
  actorPermissions: readonly PanelPermission[] | undefined,
  scopes: readonly ManagementScope[],
): boolean {
  return scopes.every((scope) =>
    hasPanelPermission(
      actorRole,
      actorPermissions,
      requiredPanelPermissionForScope(scope),
    ),
  );
}
