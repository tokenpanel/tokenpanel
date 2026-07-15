import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import {
  getDb,
  type ApiKeyDoc,
  type CustomerDoc,
  type ManagementApiKeyDoc,
  type ManagementScope,
} from "@tokenpanel/db";
import { hashToken, safeHashEqual } from "../lib/crypto.ts";
import { apiKeyThrottle } from "../lib/throttle.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../services/api-key-issuer.ts";

/**
 * Discriminated public principal. Both kinds carry orgId (always owned by the
 * key). Customer-key path keeps `customer` + `apiKey` so existing /v1 handler
 * code that reads `c.get("customer")` / `c.get("apiKey")` is unchanged. The
 * `principal` field is the canonical source for handlers that need to branch
 * on key kind (chat/completions, messages).
 */
export type PublicPrincipal =
  | {
      kind: "customer";
      orgId: ObjectId;
      customer: CustomerDoc;
      apiKey: ApiKeyDoc;
    }
  | {
      kind: "management";
      orgId: ObjectId;
      managementKey: ManagementApiKeyDoc;
    };

export type PublicAuthVariables = {
  /** Always set (both kinds). */
  orgId: ObjectId;
  /**
   * Discriminated principal. /v1 handlers should read this when they need to
   * behave differently for management vs customer keys.
   */
  principal: PublicPrincipal;
  /**
   * Present only when the principal is a customer key. Left optional so that
   * existing handler code (`c.get("customer")`) still works unchanged on the
   * customer-key path. Management handlers MUST resolve their own customer via
   * customerEmail when needed.
   */
  customer?: CustomerDoc;
  apiKey?: ApiKeyDoc;
};

/**
 * Token prefix length used for lookup and display. Owned by api-key-issuer;
 * re-exported for auth dispatchers and tests.
 */
export const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;
export const CUSTOMER_KEY_PREFIX = CUSTOMER_KEY_PREFIX_LITERAL;
export const MANAGEMENT_KEY_PREFIX = MANAGEMENT_KEY_PREFIX_LITERAL;

/** Minimum full-key length we'll consider for auth (paranoia floor). */
const MIN_FULL_KEY_LENGTH = PREFIX_LENGTH;

function classifyKey(fullKey: string): "customer" | "management" | null {
  if (fullKey.startsWith(CUSTOMER_KEY_PREFIX)) return "customer";
  if (fullKey.startsWith(MANAGEMENT_KEY_PREFIX)) return "management";
  return null;
}

async function authenticateCustomer(
  db: Awaited<ReturnType<typeof getDb>>,
  fullKey: string,
): Promise<
  | { kind: "customer"; orgId: ObjectId; customer: CustomerDoc; apiKey: ApiKeyDoc; prefix: string }
  | { kind: "customer_status"; status: 403; prefix: string }
  | { failed: true }
> {
  const prefix = fullKey.slice(0, PREFIX_LENGTH);
  const apiKey = await db.apiKeys.findOne({ prefix });
  if (!apiKey) return { failed: true };
  if (!safeHashEqual(hashToken(fullKey), apiKey.keyHash)) {
    return { failed: true };
  }
  if (apiKey.status !== "active") return { failed: true };

  // Key authenticated. Customer status failures below are NOT auth failures
  // — they must return 403 (not 401) and must NOT poison the brute-force
  // throttle, otherwise a valid key with a suspended customer locks the
  // customer out of all other valid keys after a few requests. The dispatcher
  // records success before translating this to a 403.
  const customer = await db.customers.findOne({ _id: apiKey.customerId });
  if (!customer) return { kind: "customer_status", status: 403, prefix };
  if (customer.status !== "active") return { kind: "customer_status", status: 403, prefix };

  return { kind: "customer", orgId: customer.organizationId, customer, apiKey, prefix };
}

async function authenticateManagement(
  db: Awaited<ReturnType<typeof getDb>>,
  fullKey: string,
): Promise<
  | { kind: "management"; orgId: ObjectId; managementKey: ManagementApiKeyDoc; prefix: string }
  | { failed: true }
> {
  const prefix = fullKey.slice(0, PREFIX_LENGTH);
  const mgmtKey = await db.managementApiKeys.findOne({ prefix });
  if (!mgmtKey) return { failed: true };
  if (!safeHashEqual(hashToken(fullKey), mgmtKey.keyHash)) {
    return { failed: true };
  }
  if (mgmtKey.status !== "active") return { failed: true };

  return {
    kind: "management",
    orgId: mgmtKey.organizationId,
    managementKey: mgmtKey,
    prefix,
  };
}

/**
 * Public auth for /v1 routes — dispatches on the key prefix.
 *
 *  - `tp_live_` → customer API key path (existing behavior preserved exactly:
 *    sets `customer`, `apiKey`, `orgId`). Customer status is enforced here.
 *  - `tp_mgmt_` → management API key path (sets `managementKey`, `orgId`, no
 *    customer). Customer resolution (when a request carries customerEmail) is
 *    the handler's job so per-route attribution rules apply.
 *
 * Brute-force throttling and constant-time hash comparison apply identically
 * to both key kinds. OrgId always comes from the key — never from the request
 * — so cross-org customer lookup is structurally impossible.
 *
 * For backward compatibility with /v1 handlers that read `c.get("customer")`,
 * the customer / apiKey fields are still set on the customer path.
 */
export const requirePublicPrincipal: MiddlewareHandler<{
  Variables: PublicAuthVariables;
}> = async (c, next) => {
  const auth = c.req.header("authorization");
  if (!auth) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return c.json({ error: "unauthorized" }, 401);
  }
  const fullKey = parts[1];
  if (!fullKey || fullKey.length < MIN_FULL_KEY_LENGTH) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const kind = classifyKey(fullKey);
  if (kind === null) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Throttle brute-force attempts per key prefix before touching the DB.
  // Same throttle instance for both kinds — the attack surface (any valid
  // prefix) is the same, and a single bucket per prefix is the right unit.
  const throttlePrefix = fullKey.slice(0, PREFIX_LENGTH);
  const gate = apiKeyThrottle.check(throttlePrefix);
  if (!gate.allowed) {
    return c.json({ error: "unauthorized" }, 401, {
      "Retry-After": String(gate.retryAfterSeconds),
    });
  }

  const db = await getDb();

  let principal: PublicPrincipal;
  let authenticatedPrefix: string;
  if (kind === "customer") {
    const r = await authenticateCustomer(db, fullKey);
    if ("failed" in r) {
      // Auth failure: unknown prefix, hash mismatch, or revoked key. Counts
      // against the brute-force throttle.
      apiKeyThrottle.recordFailure(throttlePrefix);
      return c.json({ error: "unauthorized" }, 401);
    }
    // Key authenticated — clear failure history BEFORE any customer status
    // check. A downstream 403 (customer missing / suspended / closed) is not
    // an auth failure and must not poison the throttle for this prefix.
    apiKeyThrottle.recordSuccess(throttlePrefix);
    if (r.kind === "customer_status") {
      // Valid key, but the customer cannot use the API right now.
      return c.json({ error: "forbidden" }, 403);
    }
    principal = r;
    authenticatedPrefix = r.prefix;
    c.set("customer", r.customer);
    c.set("apiKey", r.apiKey);
  } else {
    const r = await authenticateManagement(db, fullKey);
    if ("failed" in r) {
      apiKeyThrottle.recordFailure(throttlePrefix);
      return c.json({ error: "unauthorized" }, 401);
    }
    // Management keys have no per-customer status, so any post-key-valid
    // failure is a scope check (403) handled by the route middleware.
    apiKeyThrottle.recordSuccess(throttlePrefix);
    principal = r;
    authenticatedPrefix = r.prefix;
  }

  c.set("orgId", principal.orgId);
  c.set("principal", principal);

  // Fire-and-forget lastUsedAt update so we don't add a DB round-trip to the
  // critical path. Errors are logged but never surfaced — lastUsedAt is best
  // effort and must not affect auth.
  const coll = kind === "customer" ? db.apiKeys : db.managementApiKeys;
  coll
    .updateOne({ prefix: authenticatedPrefix }, { $set: { lastUsedAt: new Date() } })
    .catch((err: unknown) => {
      console.error("failed to update lastUsedAt:", err);
    });

  await next();
};

/**
 * Backward-compatible alias. /v1 routes that have not been migrated to read
 * `principal` continue to work via this name, but new code should use
 * requirePublicPrincipal (the dispatcher covers both key kinds).
 */
export const requireCustomerKey = requirePublicPrincipal;

/**
 * Helper for management routes (and /v1 handlers branching on the management
 * principal) to assert a scope. Returns a 403 response object suitable for
 * direct return, or null when the scope is present. Uniform error shape so
 * the existence of the underlying resource is not leaked.
 */
export function denyIfMissingScope(
  principal: PublicPrincipal,
  required: ManagementScope,
): Response | null {
  if (principal.kind !== "management") return null;
  if (!principal.managementKey.scopes.includes(required)) {
    return new Response(
      JSON.stringify({ error: "forbidden", reason: "missing_scope" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return null;
}
