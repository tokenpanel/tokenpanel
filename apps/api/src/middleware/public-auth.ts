import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import {
  type ApiKeyDoc,
  type CustomerDoc,
  type ManagementApiKeyDoc,
  type ManagementScope,
} from "@tokenpanel/db";
import { Effect } from "effect";
import { apiKeyThrottle } from "../lib/throttle.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  CUSTOMER_KEY_PREFIX_LITERAL,
  MANAGEMENT_KEY_PREFIX_LITERAL,
} from "../config/security-policy.ts";
import {
  resolvePublicPrincipal,
  touchPublicKeyLastUsed,
  type ResolvedPublicPrincipal,
} from "../domains/auth/session.ts";
import { runMiddlewareEffect } from "../http/adapters/boundary.ts";
import { isAppError } from "../errors/families.ts";
import { renderAdminError } from "../http/renderers/admin.ts";
import { getAppRuntime } from "../runtime/app-runtime.ts";
import { AuthorizationError } from "../errors/families.ts";

/**
 * Discriminated public principal. Both kinds carry orgId (always owned by the
 * key). Customer-key path keeps `customer` + `apiKey` so existing /v1 handler
 * code that reads `c.get("customer")` / `c.get("apiKey")` is unchanged.
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
  orgId: ObjectId;
  principal: PublicPrincipal;
  customer?: CustomerDoc;
  apiKey?: ApiKeyDoc;
};

const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;
const CUSTOMER_KEY_PREFIX = CUSTOMER_KEY_PREFIX_LITERAL;
const MANAGEMENT_KEY_PREFIX = MANAGEMENT_KEY_PREFIX_LITERAL;
const MIN_FULL_KEY_LENGTH = PREFIX_LENGTH;

function classifyKey(fullKey: string): "customer" | "management" | null {
  if (fullKey.startsWith(CUSTOMER_KEY_PREFIX)) return "customer";
  if (fullKey.startsWith(MANAGEMENT_KEY_PREFIX)) return "management";
  return null;
}

function toPublicPrincipal(r: ResolvedPublicPrincipal): PublicPrincipal {
  if (r.kind === "customer") {
    return {
      kind: "customer",
      orgId: r.orgId,
      customer: r.customer,
      apiKey: r.apiKey,
    };
  }
  return {
    kind: "management",
    orgId: r.orgId,
    managementKey: r.managementKey,
  };
}

/**
 * Public auth for /v1 and management routes — domain principal resolution
 * via ManagedRuntime (required; no legacy getDb fallback).
 *
 * Enumeration-safe: all auth failures → generic 401.
 * Customer inactive with valid key → 403 (not throttle poison).
 */
export const requirePublicPrincipal: MiddlewareHandler<{
  Variables: PublicAuthVariables;
}> = async (c, next) => {
  const auth = c.req.header("authorization");

  // Throttle before DB.
  if (auth) {
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0] === "Bearer" && parts[1]) {
      const fullKey = parts[1];
      if (fullKey.length >= MIN_FULL_KEY_LENGTH && classifyKey(fullKey)) {
        const throttlePrefix = fullKey.slice(0, PREFIX_LENGTH);
        const gate = apiKeyThrottle.check(throttlePrefix);
        if (!gate.allowed) {
          return c.json({ error: "unauthorized" }, 401, {
            "Retry-After": String(gate.retryAfterSeconds),
          });
        }
      }
    }
  }

  const throttlePrefix =
    auth && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).slice(0, PREFIX_LENGTH)
      : null;

  const denied = await runMiddlewareEffect(
    c,
    resolvePublicPrincipal(auth),
    {
      surface: "admin", // unauthorized envelope is { error: "unauthorized" }
      onSuccess: (resolved) => {
        const principal = toPublicPrincipal(resolved);
        c.set("orgId", principal.orgId);
        c.set("principal", principal);
        if (principal.kind === "customer") {
          c.set("customer", principal.customer);
          c.set("apiKey", principal.apiKey);
        }
        if (throttlePrefix) {
          apiKeyThrottle.recordSuccess(throttlePrefix);
        }
        // Fire-and-forget lastUsedAt
        void getAppRuntime().runPromise(
          touchPublicKeyLastUsed(resolved).pipe(
            Effect.catchAll(() => Effect.void),
          ),
        );
      },
      mapError: (err) => {
        if (!isAppError(err)) return null;
        // Auth failures count against throttle.
        if (
          err._tag === "AuthenticationError" &&
          throttlePrefix !== null
        ) {
          apiKeyThrottle.recordFailure(throttlePrefix);
        }
        // Customer inactive: valid key → clear throttle, return 403.
        if (
          err._tag === "AuthorizationError" &&
          throttlePrefix !== null
        ) {
          apiKeyThrottle.recordSuccess(throttlePrefix);
        }
        if (err._tag === "AuthorizationError") {
          return {
            status: 403,
            body: { error: "forbidden" },
            headers: {},
          };
        }
        return renderAdminError(err);
      },
    },
  );
  if (denied) return denied;
  await next();
};

export const requireCustomerKey = requirePublicPrincipal;

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

void AuthorizationError;
