/**
 * /v1 chat principal → billing context resolution.
 * Primary API is resolveChatContextEffect (routes). Promise resolveChatContext
 * remains for unit/integration tests that inject TypedDb.
 */

import { Cause, Effect, Exit } from "effect";
import { ObjectId } from "mongodb";
import type { CustomerDoc, TypedDb } from "@tokenpanel/db";
import type { PublicPrincipal } from "../middleware/public-auth.ts";
import { CustomersRepo } from "../infrastructure/mongo/repositories/customers.ts";
import type { SettlementActor } from "../domains/settlement/settle.ts";

/**
 * Error thrown by resolveChatContext when the request cannot proceed.
 * Mirrors AppError-shaped status/code for /v1 OpenAI or Anthropic envelopes.
 */
export class V1ChatError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "V1ChatError";
    this.status = status;
    this.code = code;
  }
}

export type ChatContext =
  | {
      kind: "customer";
      orgId: ObjectId;
      customer: CustomerDoc;
      apiKeyId: ObjectId;
      modelWhitelist: string[];
    }
  | {
      kind: "management_internal";
      orgId: ObjectId;
      managementKeyId: ObjectId;
    }
  | {
      kind: "management_attributed";
      orgId: ObjectId;
      managementKeyId: ObjectId;
      customer: CustomerDoc;
      customerEmail: string;
    };

/**
 * Build the chat context for a /v1 request (Effect).
 */
export const resolveChatContextEffect = (params: {
  principal: PublicPrincipal;
  customerEmail?: string | undefined;
}): Effect.Effect<ChatContext, V1ChatError, CustomersRepo> =>
  Effect.gen(function* () {
    const { principal } = params;

    if (principal.kind === "customer") {
      return {
        kind: "customer" as const,
        orgId: principal.orgId,
        customer: principal.customer,
        apiKeyId: principal.apiKey._id,
        modelWhitelist: principal.apiKey.modelWhitelist,
      };
    }

    if (!principal.managementKey.scopes.includes("chat:write")) {
      return yield* Effect.fail(
        new V1ChatError(
          403,
          "missing_scope",
          "Management key lacks chat:write scope",
        ),
      );
    }

    const email = params.customerEmail?.trim().toLowerCase();
    if (!email) {
      return {
        kind: "management_internal" as const,
        orgId: principal.orgId,
        managementKeyId: principal.managementKey._id,
      };
    }

    const customers = yield* CustomersRepo;
    const customer = (yield* customers
      .findByOrgEmail(principal.orgId, email)
      .pipe(
        Effect.mapError(
          (e) =>
            new V1ChatError(
              500,
              "system_error",
              e instanceof Error ? e.message : String(e),
            ),
        ),
      )) as CustomerDoc | null;

    if (!customer) {
      return yield* Effect.fail(
        new V1ChatError(
          404,
          "customer_not_found",
          `No customer with email '${email}' in this organization`,
        ),
      );
    }
    if (customer.status !== "active") {
      return yield* Effect.fail(
        new V1ChatError(
          403,
          "customer_inactive",
          `Customer '${email}' is not active`,
        ),
      );
    }

    return {
      kind: "management_attributed" as const,
      orgId: principal.orgId,
      managementKeyId: principal.managementKey._id,
      customer,
      customerEmail: email,
    };
  });

/**
 * Promise adapter for tests. Supports optional `db` injection.
 * Production routes use resolveChatContextEffect.
 */
export async function resolveChatContext(params: {
  principal: PublicPrincipal;
  customerEmail?: string | undefined;
  /** @deprecated Test harness only. */
  db?: TypedDb | undefined;
}): Promise<ChatContext> {
  const { principal } = params;

  if (principal.kind === "customer") {
    return {
      kind: "customer",
      orgId: principal.orgId,
      customer: principal.customer,
      apiKeyId: principal.apiKey._id,
      modelWhitelist: principal.apiKey.modelWhitelist,
    };
  }

  if (!principal.managementKey.scopes.includes("chat:write")) {
    throw new V1ChatError(
      403,
      "missing_scope",
      "Management key lacks chat:write scope",
    );
  }

  const email = params.customerEmail?.trim().toLowerCase();
  if (!email) {
    return {
      kind: "management_internal",
      orgId: principal.orgId,
      managementKeyId: principal.managementKey._id,
    };
  }

  // Test harness: direct TypedDb read.
  if (params.db) {
    const customer = await params.db.customers.findOne({
      organizationId: principal.orgId,
      email,
    });
    if (!customer) {
      throw new V1ChatError(
        404,
        "customer_not_found",
        `No customer with email '${email}' in this organization`,
      );
    }
    if (customer.status !== "active") {
      throw new V1ChatError(
        403,
        "customer_inactive",
        `Customer '${email}' is not active`,
      );
    }
    return {
      kind: "management_attributed",
      orgId: principal.orgId,
      managementKeyId: principal.managementKey._id,
      customer,
      customerEmail: email,
    };
  }

  const { getAppRuntime, isAppRuntimeInstalled } = await import(
    "../runtime/app-runtime.ts"
  );
  if (!isAppRuntimeInstalled()) {
    throw new V1ChatError(500, "system_error", "ManagedRuntime not installed");
  }
  const exit = await getAppRuntime().runPromiseExit(
    resolveChatContextEffect({
      principal,
      customerEmail: params.customerEmail,
    }) as Effect.Effect<ChatContext, V1ChatError, never>,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failures = [...Cause.failures(exit.cause)];
  if (failures[0] !== undefined) throw failures[0];
  throw Cause.squash(exit.cause);
}

/** Map a chat context to the SettlementActor shape used by settleUsage. */
export function actorForChatContext(ctx: ChatContext): SettlementActor {
  if (ctx.kind === "customer") {
    return {
      actorKind: "customer_key" as const,
      customerId: ctx.customer._id,
      apiKeyId: ctx.apiKeyId,
    };
  }
  if (ctx.kind === "management_internal") {
    return {
      actorKind: "management_key" as const,
      customerId: null,
      managementKeyId: ctx.managementKeyId,
    };
  }
  return {
    actorKind: "management_key" as const,
    customerId: ctx.customer._id,
    managementKeyId: ctx.managementKeyId,
    customerEmail: ctx.customerEmail,
  };
}

/** CustomerId to bill, or null for org-internal calls (skip preflight billing). */
export function billableCustomerId(ctx: ChatContext): ObjectId | null {
  return ctx.kind === "management_internal" ? null : ctx.customer._id;
}

/** Model whitelist from the principal (empty for management). */
export function modelWhitelistForContext(ctx: ChatContext): string[] {
  return ctx.kind === "customer" ? ctx.modelWhitelist : [];
}
