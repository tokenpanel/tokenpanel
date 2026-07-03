import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import { getDb, type ApiKeyDoc, type CustomerDoc } from "@tokenpanel/db";
import { hashToken, safeHashEqual } from "../lib/crypto.ts";
import { apiKeyThrottle } from "../lib/throttle.ts";

export type PublicAuthVariables = {
  customer: CustomerDoc;
  apiKey: ApiKeyDoc;
  orgId: ObjectId;
};

const PREFIX_LENGTH = 12;

export const requireCustomerKey: MiddlewareHandler<{
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
  if (!fullKey || fullKey.length < PREFIX_LENGTH) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const prefix = fullKey.slice(0, PREFIX_LENGTH);

  // Throttle brute-force attempts per key prefix before touching the DB.
  const gate = apiKeyThrottle.check(prefix);
  if (!gate.allowed) {
    return c.json({ error: "unauthorized" }, 401, {
      "Retry-After": String(gate.retryAfterSeconds),
    });
  }

  const db = await getDb();

  const apiKey = await db.apiKeys.findOne({ prefix });
  if (!apiKey) {
    apiKeyThrottle.recordFailure(prefix);
    return c.json({ error: "unauthorized" }, 401);
  }

  // Constant-time hash comparison: a normal `===` short-circuits on the first
  // differing byte and leaks how many leading hash bytes matched via timing.
  if (!safeHashEqual(hashToken(fullKey), apiKey.keyHash)) {
    apiKeyThrottle.recordFailure(prefix);
    return c.json({ error: "unauthorized" }, 401);
  }

  if (apiKey.status !== "active") {
    apiKeyThrottle.recordFailure(prefix);
    return c.json({ error: "unauthorized" }, 401);
  }

  // Key authenticated — clear its failure history before the (separate) customer
  // status checks, which return 403 rather than counting as key-auth failures.
  apiKeyThrottle.recordSuccess(prefix);

  const customer = await db.customers.findOne({ _id: apiKey.customerId });
  if (!customer) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (customer.status !== "active") {
    return c.json({ error: "forbidden" }, 403);
  }

  c.set("customer", customer as CustomerDoc);
  c.set("apiKey", apiKey as ApiKeyDoc);
  c.set("orgId", customer.organizationId);

  db.apiKeys
    .updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } })
    .catch((err: unknown) => {
      console.error("failed to update lastUsedAt:", err);
    });

  await next();
};