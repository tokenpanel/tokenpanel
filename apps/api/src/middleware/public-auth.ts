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
import { getRequestClientIp } from "../lib/client-ip.ts";
import {
  resolvePublicPrincipal,
  touchPublicKeyLastUsed,
  type ResolvedPublicPrincipal,
} from "../domains/auth/session.ts";
import { runMiddlewareEffect } from "../http/adapters/boundary.ts";
import { isAppError, AuthorizationError } from "../errors/families.ts";
import { renderAdminError } from "../http/renderers/admin.ts";
import { getAppRuntime } from "../runtime/app-runtime.ts";

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
  const clientIp = getRequestClientIp(c);
  // Count failures for any Bearer attempt (shape checked only for early gate
  // path that previously required a classifiable key). IP is the sole bucket.
  const attemptedBearer =
    !!auth &&
    auth.startsWith("Bearer ") &&
    auth.slice("Bearer ".length).length > 0;

  // Throttle before DB — per client IP (not key prefix).
  if (attemptedBearer) {
    const gate = apiKeyThrottle.check(clientIp);
    if (!gate.allowed) {
      return c.json({ error: "unauthorized" }, 401, {
        "Retry-After": String(gate.retryAfterSeconds),
      });
    }
  }

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
        if (attemptedBearer) {
          apiKeyThrottle.recordSuccess(clientIp);
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
          attemptedBearer
        ) {
          apiKeyThrottle.recordFailure(clientIp);
        }
        // Customer inactive: valid key → clear throttle, return 403.
        if (
          err._tag === "AuthorizationError" &&
          attemptedBearer
        ) {
          apiKeyThrottle.recordSuccess(clientIp);
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
