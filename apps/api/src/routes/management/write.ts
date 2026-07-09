import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { ObjectId } from "mongodb";
import type { Filter } from "mongodb";
import {
  getDb,
  getClient,
  customerCreateInput,
  customerUpdateInput,
  type CustomerDoc,
  type BalanceAdjustmentDoc,
  type SubscriptionDoc,
} from "@tokenpanel/db";
import type { PublicAuthVariables } from "../../middleware/public-auth.ts";
import {
  requireManagementScope,
} from "../../middleware/management-auth.ts";
import { isDuplicateKeyError } from "../../lib/crypto.ts";

type ManagementAuthVariables = PublicAuthVariables;

/**
 * Management server-to-server write endpoints. Mirrors the admin customer
 * lifecycle (create / update / status / top-up / subscribe) but auth = a
 * management API key with the matching fine-grained scope. Every write is
 * scoped to the management key's org, so cross-org writes are structurally
 * impossible (every filter includes organizationId).
 *
 * Provider / model / admin-user mutations are deliberately NOT exposed here:
 * those remain admin-JWT-only.
 *
 * Auth (requirePublicPrincipal + requireManagementPrincipal) is mounted once
 * on the parent app for /api/management/* — this router only adds scope gates.
 */
const managementWrite = new Hono<{ Variables: ManagementAuthVariables }>();

function parseObjectIdParam(id: string): ObjectId | null {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
}

const NOTE_MAX = 280;

/** Stamp a note on a balance adjustment so the ledger records who acted. */
function mgmtActorNote(prefix: string | undefined): string | null {
  if (!prefix) return null;
  // The stored prefix is non-secret; full key never persists.
  return `via mgmt key ${prefix}`;
}

/**
 * Join caller note + actor provenance, hard-capped at the schema max so a
 * long note + key suffix cannot exceed balance_adjustments.note max (280).
 */
function composeLedgerNote(callerNote: string | undefined, prefix: string | undefined): string | null {
  const actor = mgmtActorNote(prefix);
  const parts = [callerNote, actor].filter((p): p is string => Boolean(p && p.length > 0));
  if (parts.length === 0) return null;
  const joined = parts.join(" · ");
  return joined.length <= NOTE_MAX ? joined : joined.slice(0, NOTE_MAX);
}

/**
 * Sentinel thrown inside the balance-write transaction when the
 * findOneAndUpdate matches no row (customer deleted/closed-currency-changed
 * between the existence check and the txn). Aborts the txn so the ledger
 * insert rolls back; the caller maps it to a 404.
 */
class BalanceCustomerGone extends Error {}

// ---------------------------------------------------------------------------
// Customers (customers:write)
// ---------------------------------------------------------------------------

managementWrite.post(
  "/api/management/customers",
  requireManagementScope("customers:write"),
  zValidator("json", customerCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const principal = c.get("principal");
    const body = c.req.valid("json");
    const db = await getDb();

    const now = new Date();
    const startingBalance = body.startingBalance ?? { amountMinor: 0, currency: "USD" };

    // Non-zero opening balance is a money write. Require balances:write so
    // customers:write alone cannot mint unledgered credit.
    if (startingBalance.amountMinor !== 0) {
      if (
        !principal ||
        principal.kind !== "management" ||
        !principal.managementKey.scopes.includes("balances:write")
      ) {
        return c.json({ error: "forbidden", reason: "missing_scope", scope: "balances:write" }, 403);
      }
    }

    // Duplicate detection is org-scoped — a same-email customer in another org
    // is invisible to this key and does not collide. Unique index is the race
    // safety net after the post-migration unique email index is applied.
    const or: Filter<CustomerDoc>[] = [];
    if (body.externalId !== undefined) or.push({ externalId: body.externalId });
    if (body.email !== undefined) or.push({ email: body.email });
    if (or.length > 0) {
      const conflict = await db.customers.findOne({
        organizationId: orgId,
        $or: or,
      } as Filter<CustomerDoc>);
      if (conflict) {
        return c.json({ error: "duplicate_external_id_or_email" }, 409);
      }
    }

    const customerId = new ObjectId();
    const doc: CustomerDoc = {
      _id: customerId,
      organizationId: orgId,
      externalId: body.externalId ?? null,
      name: body.name,
      email: body.email ?? null,
      balance: startingBalance,
      status: "active",
      metadata: body.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const prefix =
      principal && principal.kind === "management" ? principal.managementKey.prefix : undefined;

    // Insert customer (+ optional opening ledger) in one transaction so a
    // non-zero starting balance never exists without a matching ledger row.
    const session = getClient().startSession();
    let created: CustomerDoc | null = null;
    try {
      await session.withTransaction(async () => {
        await db.customers.insertOne(doc, { session });
        if (startingBalance.amountMinor !== 0) {
          const adjustment: BalanceAdjustmentDoc = {
            _id: new ObjectId(),
            organizationId: orgId,
            customerId,
            amountMinor: startingBalance.amountMinor,
            currency: startingBalance.currency,
            reason: "topup",
            usageRecordId: null,
            note: composeLedgerNote("opening balance", prefix),
            occurredAt: now,
            createdAt: now,
            updatedAt: now,
          };
          await db.balanceAdjustments.insertOne(adjustment, { session });
        }
        created = doc;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return c.json({ error: "duplicate_external_id_or_email" }, 409);
      }
      throw err;
    } finally {
      await session.endSession();
    }
    if (!created) return c.json({ error: "insert_failed" }, 500);
    return c.json(created as CustomerDoc, 201);
  },
);

managementWrite.patch(
  "/api/management/customers/:id",
  requireManagementScope("customers:write"),
  zValidator("json", customerUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    const update: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue;
      update[k] = v;
    }

    if (body.externalId !== undefined || body.email !== undefined) {
      const or: Filter<CustomerDoc>[] = [];
      if (body.externalId !== undefined) or.push({ externalId: body.externalId });
      if (body.email !== undefined) or.push({ email: body.email });
      const dup = await db.customers.findOne({
        organizationId: orgId,
        _id: { $ne: oid },
        $or: or,
      } as Filter<CustomerDoc>);
      if (dup) return c.json({ error: "duplicate_external_id_or_email" }, 409);
    }

    try {
      const updated = await db.customers.findOneAndUpdate(
        { _id: oid, organizationId: orgId },
        { $set: update },
        { returnDocument: "after" },
      );
      if (!updated) return c.json({ error: "not_found" }, 404);
      return c.json(updated as CustomerDoc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return c.json({ error: "duplicate_external_id_or_email" }, 409);
      }
      throw err;
    }
  },
);

const statusBody = z.object({
  status: z.enum(["active", "suspended", "closed"]),
});

/**
 * POST /api/management/customers/:id/status — suspend / reactivate / close.
 * (customers:write). Distinct verb from PATCH so callers cannot accidentally
 * flip status while updating profile fields, and so audit logs clearly mark
 * status transitions.
 */
managementWrite.post(
  "/api/management/customers/:id/status",
  requireManagementScope("customers:write"),
  zValidator("json", statusBody),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();
    const updated = await db.customers.findOneAndUpdate(
      { _id: oid, organizationId: orgId },
      { $set: { status: body.status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json(updated as CustomerDoc);
  },
);

// ---------------------------------------------------------------------------
// Balances (balances:write)
// ---------------------------------------------------------------------------

const balanceBody = z.object({
  amountMinor: z.number().int(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  reason: z.enum(["topup", "adjustment", "refund"]).default("topup"),
  note: z.string().max(NOTE_MAX).optional(),
});

managementWrite.post(
  "/api/management/customers/:id/balance",
  requireManagementScope("balances:write"),
  zValidator("json", balanceBody),
  async (c) => {
    const orgId = c.get("orgId");
    const principal = c.get("principal");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    const customer = await db.customers.findOne({ _id: oid, organizationId: orgId });
    if (!customer) return c.json({ error: "not_found" }, 404);

    // Never relabel an existing nonzero (or zero-with-currency) balance by
    // overwriting currency. amountMinor: 0 + different currency would otherwise
    // turn USD balances into EUR without conversion.
    if (customer.balance.currency !== body.currency) {
      if (customer.balance.amountMinor !== 0) {
        return c.json(
          {
            error: "currency_mismatch",
            balanceCurrency: customer.balance.currency,
            requestCurrency: body.currency,
          },
          409,
        );
      }
      // amountMinor === 0: allow setting the currency on an empty wallet.
    }

    const prefix =
      principal && principal.kind === "management" ? principal.managementKey.prefix : undefined;

    const now = new Date();
    const adjustment: BalanceAdjustmentDoc = {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: oid,
      amountMinor: body.amountMinor,
      currency: body.currency,
      reason: body.reason,
      usageRecordId: null,
      // Caller note + actor provenance. Both co-exist so an admin reading the
      // ledger later can see who acted AND why. Hard-capped at schema max.
      note: composeLedgerNote(body.note, prefix),
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // Insert the ledger entry and mutate the balance inside ONE transaction
    // so a transient failure (or a customer deleted mid-call) cannot leave a
    // ledger row without the matching balance mutation, or vice versa.
    const session = getClient().startSession();
    let updated: CustomerDoc | null = null;
    try {
      await session.withTransaction(async () => {
        await db.balanceAdjustments.insertOne(adjustment, { session });
        const setFields: Record<string, unknown> = { updatedAt: now };
        // Only set currency when the wallet is empty (opening / currency pick)
        // or already matches — never overwrite a different currency.
        if (
          customer.balance.currency !== body.currency &&
          customer.balance.amountMinor === 0
        ) {
          setFields["balance.currency"] = body.currency;
        }
        const res = await db.customers.findOneAndUpdate(
          {
            _id: oid,
            organizationId: orgId,
            // Re-check currency inside the txn to close TOCTOU races.
            "balance.currency": customer.balance.currency,
          },
          {
            $inc: { "balance.amountMinor": body.amountMinor },
            $set: setFields,
          },
          { returnDocument: "after", session },
        );
        if (!res) throw new BalanceCustomerGone();
        updated = res as CustomerDoc;
      });
    } catch (err) {
      if (!(err instanceof BalanceCustomerGone)) throw err;
    } finally {
      await session.endSession();
    }
    if (!updated) return c.json({ error: "not_found" }, 404);

    return c.json({ customer: updated, adjustment }, 201);
  },
);

// ---------------------------------------------------------------------------
// Subscriptions (subscriptions:write)
// ---------------------------------------------------------------------------

const subscribeBody = z.object({
  planId: z.string().min(1).max(64),
});

export function addInterval(date: Date, interval: string, count: number): Date {
  const d = new Date(date);
  switch (interval) {
    case "day":
      d.setUTCDate(d.getUTCDate() + count);
      return d;
    case "week":
      d.setUTCDate(d.getUTCDate() + count * 7);
      return d;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + count);
      return d;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + count);
      return d;
    default:
      return d;
  }
}

managementWrite.post(
  "/api/management/customers/:id/subscribe",
  requireManagementScope("subscriptions:write"),
  zValidator("json", subscribeBody),
  async (c) => {
    const orgId = c.get("orgId");
    const oid = parseObjectIdParam(c.req.param("id"));
    if (!oid) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const db = await getDb();

    if (!ObjectId.isValid(body.planId)) {
      return c.json({ error: "plan_not_found" }, 404);
    }
    const planId = new ObjectId(body.planId);

    const customer = await db.customers.findOne({ _id: oid, organizationId: orgId });
    if (!customer) return c.json({ error: "not_found" }, 404);

    const plan = await db.subscriptionPlans.findOne({ _id: planId, organizationId: orgId });
    if (!plan) return c.json({ error: "plan_not_found" }, 404);
    if (!plan.active) return c.json({ error: "plan_not_active" }, 409);

    const existing = await db.subscriptions.findOne({
      organizationId: orgId,
      customerId: oid,
      status: "active",
    });
    if (existing) {
      return c.json(
        { error: "subscription_already_active", subscriptionId: existing._id },
        409,
      );
    }

    const now = new Date();
    const periodEnd = addInterval(now, plan.interval, plan.intervalCount);
    const subscription: SubscriptionDoc = {
      _id: new ObjectId(),
      organizationId: orgId,
      customerId: oid,
      planId,
      status: "active",
      periodStart: now,
      periodEnd,
      canceledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const insertResult = await db.subscriptions.insertOne(subscription);
      const created = await db.subscriptions.findOne({ _id: insertResult.insertedId });
      if (!created) return c.json({ error: "insert_failed" }, 500);
      return c.json(created as SubscriptionDoc, 201);
    } catch (err) {
      // Unique partial index on (org, customer) where status is active
      // is the race safety net for concurrent subscribe calls.
      if (isDuplicateKeyError(err)) {
        return c.json({ error: "subscription_already_active" }, 409);
      }
      throw err;
    }
  },
);

export default managementWrite;
