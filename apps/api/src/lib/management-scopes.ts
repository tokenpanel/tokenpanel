import type { ManagementScope, ManagementApiKeyDoc } from "@tokenpanel/db";
import { MANAGEMENT_SCOPES } from "@tokenpanel/db";

/**
 * Whether the given scope set grants `required`. The scope list is the
 * authoritative allow-list stored on the management key. There are no wildcard
 * scopes by design — every new capability must be added to the enum and the
 * caller must explicitly grant it.
 */
export function hasScope(
  scopes: readonly ManagementScope[],
  required: ManagementScope,
): boolean {
  return scopes.includes(required);
}

/**
 * Throw a BillingError-shaped 403 when the scope is missing. We avoid leaking
 * resource existence on authz failure (uniform 403 with no body details) — a
 * caller without the scope cannot tell whether the resource exists. The scope
 * list is the authoritative set; key revocation is enforced upstream in the
 * auth middleware so a revoked key never reaches this check.
 */
export class ManagementScopeError extends Error {
  readonly required: ManagementScope;
  constructor(required: ManagementScope) {
    super(`Management key missing required scope: ${required}`);
    this.name = "ManagementScopeError";
    this.required = required;
  }
}

/**
 * Assert the management key has the required scope. Used inside shared /v1
 * handlers (where a single key may serve multiple routes); the route-level
 * `requireManagementScope` middleware is the preferred gate for /api/management
 * routes since it short-circuits before any handler code runs.
 */
export function assertManagementScope(
  key: Pick<ManagementApiKeyDoc, "scopes">,
  required: ManagementScope,
): void {
  if (!hasScope(key.scopes, required)) {
    throw new ManagementScopeError(required);
  }
}

export { MANAGEMENT_SCOPES };
