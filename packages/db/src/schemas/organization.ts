import { z } from "zod";
import { objectId, objectIdFromString, timestampFields } from "./common.ts";

/**
 * Organization = tenant operating this panel.
 * Sells AI services to its own Customers.
 */
export const organizationDoc = z.object({
  _id: objectId,
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase, hyphenated"),
  ownerId: objectId,
  defaultCurrency: z.string().length(3).regex(/^[A-Z]{3}$/),
  ...timestampFields,
});

export const organizationCreateInput = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  ownerId: objectIdFromString,
  defaultCurrency: z.string().length(3).regex(/^[A-Z]{3}$/),
});

/** API create shape — ownerId comes from auth context, not the request body. */
export const organizationApiCreateInput = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
  defaultCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
});

/** API patch shape — all optional, validates shapes when present. */
export const organizationApiUpdateInput = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
  defaultCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
});

export type OrganizationDoc = z.infer<typeof organizationDoc>;
export type OrganizationCreateInput = z.infer<typeof organizationCreateInput>;
export type OrganizationApiCreateInput = z.infer<
  typeof organizationApiCreateInput
>;
export type OrganizationApiUpdateInput = z.infer<
  typeof organizationApiUpdateInput
>;