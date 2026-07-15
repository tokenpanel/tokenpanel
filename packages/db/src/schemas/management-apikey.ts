import { z } from "zod";
import {
  managementScopeSchema,
  MANAGEMENT_SCOPES as CONTRACT_MANAGEMENT_SCOPES,
  type ManagementScope,
} from "@tokenpanel/contracts";
import { objectId, timestampFields } from "./common.ts";

/**
 * Fine-grained scopes for management API keys.
 * Live values/descriptors: @tokenpanel/contracts (MANAGEMENT_SCOPE_DEFINITIONS).
 * Adding a capability means appending there, never loosening an existing scope.
 */
export const managementScope = managementScopeSchema;
export type { ManagementScope };

export const MANAGEMENT_SCOPES: readonly ManagementScope[] =
  CONTRACT_MANAGEMENT_SCOPES;

/**
 * Org-scoped management API key (`tp_mgmt_` prefix). Bound to an organization
 * only — never to a single customer. Used for server-to-server integration:
 * management data endpoints and (optionally) the public /v1 chat surface with
 * `chat:write`.
 *
 * Stored identically to a customer `tp_live_` key: only the prefix + SHA-256
 * hash persist. The full secret is returned exactly once at create time.
 */
export const managementApiKeyDoc = z.object({
  _id: objectId,
  organizationId: objectId,
  /** Display label. */
  name: z.string().min(1).max(120),
  /** Key prefix used for lookup (first 16 chars, non-secret). */
  prefix: z.string().min(8).max(20),
  /** SHA-256 hash of the full key. Never returned to clients. */
  keyHash: z.string().min(1),
  /** Allow-list of scopes this key may exercise. */
  scopes: z.array(managementScope).default(() => []),
  status: z.enum(["active", "revoked"]).default("active"),
  /** Last time this key authenticated a request. */
  lastUsedAt: z.instanceof(Date).nullish(),
  ...timestampFields,
});

export const managementApiKeyCreateInput = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(managementScope).default(() => []),
});

export const managementApiKeyUpdateInput = z.object({
  name: z.string().min(1).max(120).optional(),
  scopes: z.array(managementScope).optional(),
  status: z.enum(["active", "revoked"]).optional(),
});

export type ManagementApiKeyDoc = z.infer<typeof managementApiKeyDoc>;
export type ManagementApiKeyCreateInput = z.infer<typeof managementApiKeyCreateInput>;
export type ManagementApiKeyUpdateInput = z.infer<typeof managementApiKeyUpdateInput>;
