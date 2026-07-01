import type { MiddlewareHandler } from "hono";
import { ObjectId } from "mongodb";
import { getDb, type ApiKeyDoc, type CustomerDoc } from "@tokenpanel/db";
import { hashToken } from "../lib/crypto.ts";

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
  const db = await getDb();

  const apiKey = await db.apiKeys.findOne({ prefix });
  if (!apiKey) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (hashToken(fullKey) !== apiKey.keyHash) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (apiKey.status !== "active") {
    return c.json({ error: "unauthorized" }, 401);
  }

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