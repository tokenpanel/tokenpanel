/**
 * Admin panel permissions — single live descriptor source.
 *
 * Policy version: 2026-07-17
 * Values are stable public contract: changing a value is a breaking API change.
 * DB membership/invite schemas and admin UI derive from this tuple.
 *
 * Overlaps management scopes where the product concept is the same
 * (`customers:read`, `balances:write`, …). Panel-only atoms never appear on
 * management API keys unless that surface is explicitly extended.
 *
 * Effect Schema: `panelPermissionSchema` (canonical §11 path).
 */
import { Schema } from "effect";
import { withParseApi } from "./parse.ts";

export const PANEL_PERMISSION_DEFINITIONS = [
  {
    value: "dashboard:read",
    group: "Dashboard",
    description: "View organization dashboard summary.",
  },
  {
    value: "models:read",
    group: "Models",
    description: "List models and read capabilities / pricing.",
  },
  {
    value: "models:write",
    group: "Models",
    description: "Create / update / delete models, entries, and fallbacks.",
  },
  {
    value: "providers:read",
    group: "Providers",
    description:
      "List providers and non-secret metadata (credentials always masked).",
  },
  {
    value: "providers:write",
    group: "Providers",
    description: "Create / update / delete providers and set credentials.",
  },
  {
    value: "customers:read",
    group: "Customers",
    description: "Look up customers and read their details.",
  },
  {
    value: "customers:write",
    group: "Customers",
    description: "Create / update / close customers.",
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
    description: "Read usage analytics and per-customer usage.",
  },
  {
    value: "plans:read",
    group: "Plans",
    description: "List subscription plans.",
  },
  {
    value: "plans:write",
    group: "Plans",
    description: "Create / update / deactivate subscription plans.",
  },
  {
    value: "subscriptions:write",
    group: "Plans",
    description: "Assign / change a customer's subscription plan.",
  },
  {
    value: "customer_keys:read",
    group: "API Keys",
    description: "List customer API keys (metadata only).",
  },
  {
    value: "customer_keys:write",
    group: "API Keys",
    description: "Issue / update / revoke customer API keys.",
  },
  {
    value: "management_keys:read",
    group: "Management Keys",
    description: "List management API keys and their scopes.",
  },
  {
    value: "management_keys:write",
    group: "Management Keys",
    description: "Issue / update scopes / revoke management API keys.",
  },
  {
    value: "invites:read",
    group: "Members",
    description: "List pending organization invites.",
  },
  {
    value: "invites:write",
    group: "Members",
    description:
      "Create and revoke invites (may only grant role/permissions the inviter holds).",
  },
  {
    value: "organization:write",
    group: "Organization",
    description: "Update organization name, slug, or default currency.",
  },
  {
    value: "playground:write",
    group: "Playground",
    description: "Use the admin playground chat (uses provider capacity).",
  },
  {
    value: "catalog_sources:read",
    group: "Catalog",
    description: "List external catalog sources and fetch their models.",
  },
] as const;

export type PanelPermissionDefinition =
  (typeof PANEL_PERMISSION_DEFINITIONS)[number];

export type PanelPermission = PanelPermissionDefinition["value"];

export const PANEL_PERMISSIONS: readonly PanelPermission[] =
  PANEL_PERMISSION_DEFINITIONS.map((d) => d.value);

/** All `:read` permissions — useful for migration compat presets. */
export const PANEL_READ_PERMISSIONS: readonly PanelPermission[] =
  PANEL_PERMISSIONS.filter((p) => p.endsWith(":read"));

/** Non-empty tuple of permission string literals for Schema.Literal. */
const permissionLiterals = PANEL_PERMISSIONS as unknown as [
  PanelPermission,
  ...PanelPermission[],
];

export const panelPermissionSchema = withParseApi(
  Schema.Literal(...permissionLiterals),
);

/**
 * Effective permissions for a membership.
 * Admins hold the full panel catalog; members hold only their explicit grants.
 */
export function effectivePanelPermissions(
  role: "admin" | "member",
  permissions: readonly PanelPermission[] | undefined,
): readonly PanelPermission[] {
  if (role === "admin") return PANEL_PERMISSIONS;
  return permissions ?? [];
}

export function hasPanelPermission(
  role: "admin" | "member",
  permissions: readonly PanelPermission[] | undefined,
  required: PanelPermission,
): boolean {
  if (role === "admin") return true;
  return (permissions ?? []).includes(required);
}

/**
 * Whether an actor may grant a target role + permission set.
 * Rule: every effective permission of the grant must be held by the actor.
 * - Admin invite ⇒ full catalog ⇒ only admins (or holders of every atom).
 * - Member invite ⇒ only permissions the actor already has.
 */
export function canGrantPanelAccess(
  actorRole: "admin" | "member",
  actorPermissions: readonly PanelPermission[] | undefined,
  grantRole: "admin" | "member",
  grantPermissions: readonly PanelPermission[] | undefined,
): boolean {
  const held = new Set(
    effectivePanelPermissions(actorRole, actorPermissions),
  );
  const granted = effectivePanelPermissions(grantRole, grantPermissions);
  for (const p of granted) {
    if (!held.has(p)) return false;
  }
  return true;
}
