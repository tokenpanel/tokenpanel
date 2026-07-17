import { Hono } from "hono";
import { Effect } from "effect";
import type { Schema } from "effect";
import { ObjectId } from "mongodb";
import {
  modelCreateInput,
  modelUpdateInput,
  fallbackReorderInput,
  modelEntryInput,
  type ModelDoc,
  type ModelEntryDoc,
} from "@tokenpanel/db";
import type { AuthVariables } from "../middleware/auth.ts";
import { requireAuth, requireRole } from "../middleware/auth.ts";
import {
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  reorderFallbacks,
  addModelEntry,
  removeModelEntry,
  normalizeEntries as domainNormalizeEntries,
  genEntryIdFromToken,
} from "../domains/models/operations.ts";
import { runAdminEffect } from "../http/adapters/boundary.ts";
import { sValidator } from "../http/validation/validator.ts";
import { isAppError } from "../errors/families.ts";

export function genEntryId(): string {
  return new ObjectId().toHexString().slice(0, 12);
}

export function normalizeEntries(
  entries: Schema.Schema.Type<typeof modelEntryInput>[],
): ModelEntryDoc[] {
  return domainNormalizeEntries(
    entries.map((e) => ({
      id: e.id,
      providerId: e.providerId,
      upstreamModelId: e.upstreamModelId,
      cost: e.cost,
      price: e.price,
      priority: e.priority,
      active: e.active,
    })),
    () => genEntryId(),
  );
}

/**
 * Models router. ManagedRuntime required (production boot + tests install it).
 */
export function createModelRoutes(): Hono<{ Variables: AuthVariables }> {
  const modelRoutes = new Hono<{ Variables: AuthVariables }>();

  modelRoutes.use("*", requireAuth);

  modelRoutes.get("/", async (c) => {
    const orgId = c.get("orgId");
    return runAdminEffect(
      c,
      listModels(orgId.toHexString()).pipe(
        Effect.map((items) => ({ items })),
      ),
      { operation: "listModels" },
    );
  });

  modelRoutes.post(
    "/",
    requireRole("admin"),
    sValidator("json", modelCreateInput),
    async (c) => {
      const body = c.req.valid("json");
      const orgId = c.get("orgId");
      return runAdminEffect(
        c,
        createModel({
          organizationId: orgId.toHexString(),
          aliasId: body.aliasId,
          displayName: body.displayName,
          description: body.description,
          entries: body.entries as Parameters<
            typeof createModel
          >[0]["entries"],
          reasoning: body.reasoning,
          toolCall: body.toolCall,
          structuredOutput: body.structuredOutput,
          temperature: body.temperature,
          attachment: body.attachment,
          limits: body.limits,
          modalities: body.modalities as ModelDoc["modalities"],
          status: body.status,
          price: body.price,
          marginBps: body.marginBps,
          currency: body.currency,
          metadata: body.metadata,
        }),
        {
          operation: "createModel",
          successStatus: 201,
          mapError: (err) => {
            if (
              isAppError(err) &&
              err._tag === "ValidationError" &&
              err.message === "provider_not_found"
            ) {
              return {
                status: 400,
                body: { error: "provider_not_found" },
                headers: {},
              };
            }
            return null;
          },
        },
      );
    },
  );

  modelRoutes.get("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      getModel({ organizationId: orgId.toHexString(), modelId: id }),
      { operation: "getModel" },
    );
  });

  modelRoutes.patch(
    "/:id",
    requireRole("admin"),
    sValidator("json", modelUpdateInput),
    async (c) => {
      const body = c.req.valid("json");
      const orgId = c.get("orgId");
      const id = c.req.param("id");
      if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
      const { entries, ...rest } = body;
      return runAdminEffect(
        c,
        updateModel({
          organizationId: orgId.toHexString(),
          modelId: id,
          patch: rest as Record<string, unknown>,
          ...(entries !== undefined
            ? {
                entries: entries as Parameters<
                  typeof updateModel
                >[0]["entries"],
              }
            : {}),
        }),
        {
          operation: "updateModel",
          mapError: (err) => {
            if (
              isAppError(err) &&
              err._tag === "ValidationError" &&
              err.message === "provider_not_found"
            ) {
              return {
                status: 400,
                body: { error: "provider_not_found" },
                headers: {},
              };
            }
            return null;
          },
        },
      );
    },
  );

  modelRoutes.delete("/:id", requireRole("admin"), async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
    return runAdminEffect(
      c,
      deleteModel({
        organizationId: orgId.toHexString(),
        modelId: id,
      }),
      { operation: "deleteModel" },
    );
  });

  modelRoutes.put(
    "/:id/fallbacks",
    requireRole("admin"),
    sValidator("json", fallbackReorderInput),
    async (c) => {
      const orgId = c.get("orgId");
      const id = c.req.param("id");
      if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
      const body = c.req.valid("json");
      return runAdminEffect(
        c,
        reorderFallbacks({
          organizationId: orgId.toHexString(),
          modelId: id,
          entries: body.entries,
        }),
        { operation: "reorderFallbacks" },
      );
    },
  );

  modelRoutes.post(
    "/:id/entries",
    requireRole("admin"),
    sValidator("json", modelEntryInput),
    async (c) => {
      const orgId = c.get("orgId");
      const id = c.req.param("id");
      if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
      const body = c.req.valid("json");
      return runAdminEffect(
        c,
        addModelEntry({
          organizationId: orgId.toHexString(),
          modelId: id,
          entry: body as Parameters<typeof addModelEntry>[0]["entry"],
        }),
        { operation: "addModelEntry", successStatus: 201 },
      );
    },
  );

  modelRoutes.delete(
    "/:id/entries/:entryId",
    requireRole("admin"),
    async (c) => {
      const orgId = c.get("orgId");
      const id = c.req.param("id");
      const entryId = c.req.param("entryId");
      if (!ObjectId.isValid(id)) return c.json({ error: "not_found" }, 404);
      return runAdminEffect(
        c,
        removeModelEntry({
          organizationId: orgId.toHexString(),
          modelId: id,
          entryId,
        }),
        { operation: "removeModelEntry" },
      );
    },
  );

  void genEntryIdFromToken;
  return modelRoutes;
}

const modelRoutes = createModelRoutes();
export default modelRoutes;
