import { ObjectId } from "mongodb";
import { getDb, type CustomerDoc } from "@tokenpanel/db";
import type { PublicPrincipal } from "../middleware/public-auth.ts";

/**
 * Error thrown by resolveChatContext when the request cannot proceed.
 * Mirrors the BillingError shape so /v1 handlers can map it to either the
 * OpenAI or Anthropic error envelope using their existing translators.
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

/**
 * Resolved chat context, discriminated by billing intent. All three variants
 * carry orgId (always owned by the authenticated principal).
 *
 *  - `customer`             — `tp_live_` key, bill + meter the customer.
 *  - `management_internal`  — `tp_mgmt_` key, no customerEmail. Audit only.
 *  - `management_attributed`— `tp_mgmt_` key with customerEmail resolved to a
 *                             customer inside the key's org. Bill that customer.
 */
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
 * Build the chat context for a /v1 request.
 *
 *  - Customer principal → unchanged customer-key path (no email lookup).
 *  - Management principal → requires `chat:write` scope (403 if missing).
 *    When customerEmail is provided, resolves the customer inside the key's
 *    org (404 on miss; 403 if not active). Without customerEmail, returns an
 *    internal context — usage is recorded for analytics but no customer is
 *    billed and no rate-limit counters are written.
 *
 * Email matching is case-insensitive (emails are stored lowercased at create
 * time, but we lowercase defensively). Cross-org email collision is
 * structurally impossible: the lookup filter always includes the key's orgId.
 */
export async function resolveChatContext(params: {
  principal: PublicPrincipal;
  customerEmail?: string;
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

  // Management principal — chat:write scope is required for any /v1 chat call.
  if (!principal.managementKey.scopes.includes("chat:write")) {
    throw new V1ChatError(403, "missing_scope", "Management key lacks chat:write scope");
  }

  const email = params.customerEmail?.trim().toLowerCase();
  if (!email) {
    return {
      kind: "management_internal",
      orgId: principal.orgId,
      managementKeyId: principal.managementKey._id,
    };
  }

  const db = await getDb();
  // Org-scoped lookup — a same-email customer in another org can NEVER be
  // resolved by this key. Sparse index on (organizationId, email) makes this
  // O(1).
  const customer = await db.customers.findOne({
    organizationId: principal.orgId,
    email,
  });
  if (!customer) {
    throw new V1ChatError(404, "customer_not_found", `No customer with email '${email}' in this organization`);
  }
  if (customer.status !== "active") {
    throw new V1ChatError(403, "customer_inactive", `Customer '${email}' is not active`);
  }

  return {
    kind: "management_attributed",
    orgId: principal.orgId,
    managementKeyId: principal.managementKey._id,
    customer,
    customerEmail: email,
  };
}

/** Map a chat context to the SettlementActor shape used by settleUsage. */
export function actorForChatContext(ctx: ChatContext) {
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

/** Model whitelist from the principal (empty for management — no per-key whitelist). */
export function modelWhitelistForContext(ctx: ChatContext): string[] {
  return ctx.kind === "customer" ? ctx.modelWhitelist : [];
}
