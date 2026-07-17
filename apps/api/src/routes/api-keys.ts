import { Hono } from "hono";
import { Effect } from "effect";
import { ObjectId } from "mongodb";
import { apiKeyCreateInput, apiKeyUpdateInput } from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import {
  listCustomerApiKeys,
  issueCustomerApiKey,
  updateCustomerApiKey,
  revokeCustomerApiKey,
  stripCustomerKey,
} from "../domains/keys/operations.ts";
import {
  API_KEY_LOOKUP_PREFIX_CHARS,
  CUSTOMER_KEY_PREFIX_LITERAL,
} from "../domains/keys/policy.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { ApiKeyListQuery } from "../http/validation/query.ts";
import { withParseApi } from "../http/validation/with-parse-api.ts";
import { KeyRepository } from "../domains/ports/key-repository.ts";
import { NotFoundError } from "../errors/families.ts";
import { parseObjectIdParam } from "./route-utils.ts";

/** @deprecated Test helper alias — use stripCustomerKey from domains/keys. */
export const stripKey = stripCustomerKey;
export { parseObjectIdParam };
export const KEY_PREFIX_LITERAL = CUSTOMER_KEY_PREFIX_LITERAL;
export const PREFIX_LENGTH = API_KEY_LOOKUP_PREFIX_CHARS;

export const apiKeyListQuery = withParseApi(ApiKeyListQuery);

const apiKeyRoutes = new Hono<{ Variables: AuthVariables }>();

apiKeyRoutes.use("*", requireAuth);

apiKeyRoutes.get(
  "/",
  requirePermission("customer_keys:read"),
  sValidator("query", apiKeyListQuery),
  async (c) => {
    const orgId = c.get("orgId");
    const q = c.req.valid("query");
    return runAdminEffect(
      c,
      listCustomerApiKeys({
        organizationId: orgId.toHexString(),
        ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      }).pipe(Effect.map((items) => ({ items }))),
      { operation: "listCustomerApiKeys" },
    );
  },
);

apiKeyRoutes.post(
  "/",
  requirePermission("customer_keys:write"),
  sValidator("json", apiKeyCreateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      issueCustomerApiKey({
        organizationId: orgId.toHexString(),
        customerId:
          typeof body.customerId === "string"
            ? body.customerId
            : String(body.customerId),
        name: body.name,
        modelWhitelist: body.modelWhitelist ?? [],
      }).pipe(
        Effect.map((r) => ({
          ...r.apiKey,
          key: r.key,
        })),
      ),
      { operation: "issueCustomerApiKey", successStatus: 201 },
    );
  },
);

apiKeyRoutes.get(
  "/:id",
  requirePermission("customer_keys:read"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      Effect.gen(function* () {
        const keys = yield* KeyRepository;
        const doc = yield* keys.findCustomerKey(orgId.toHexString(), id);
        if (!doc) {
          return yield* Effect.fail(
            new NotFoundError({
              code: "not_found",
              message: "API key not found",
              resource: "api_key",
              id,
            }),
          );
        }
        return stripCustomerKey(doc);
      }),
      { operation: "getCustomerApiKey" },
    );
  },
);

apiKeyRoutes.patch(
  "/:id",
  requirePermission("customer_keys:write"),
  sValidator("json", apiKeyUpdateInput),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    return runAdminEffect(
      c,
      updateCustomerApiKey({
        organizationId: orgId.toHexString(),
        keyId: id,
        patch: body as Record<string, unknown>,
      }),
      { operation: "updateCustomerApiKey" },
    );
  },
);

apiKeyRoutes.delete(
  "/:id",
  requirePermission("customer_keys:write"),
  async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      revokeCustomerApiKey({
        organizationId: orgId.toHexString(),
        keyId: id,
      }),
      { operation: "revokeCustomerApiKey" },
    );
  },
);

export default apiKeyRoutes;
