/**
 * Organization schemas — Effect Schema production path (§11).
 */
import {
  OrganizationDoc as OrganizationDocSchema,
  OrganizationCreateInput as OrganizationCreateInputSchema,
  OrganizationApiCreateInput as OrganizationApiCreateInputSchema,
  OrganizationApiUpdateInput as OrganizationApiUpdateInputSchema,
  OrganizationUpdateInput as OrganizationUpdateInputSchema,
} from "./effect/organization.ts";
import { withParseApi } from "./parse.ts";
import type { MutableDeep } from "./mutable.ts";
import type { Schema } from "effect";

export const organizationDoc = withParseApi(OrganizationDocSchema);
export const organizationCreateInput = withParseApi(OrganizationCreateInputSchema);
export const organizationApiCreateInput = withParseApi(OrganizationApiCreateInputSchema);
export const organizationApiUpdateInput = withParseApi(OrganizationApiUpdateInputSchema);
export const organizationUpdateInput = withParseApi(OrganizationUpdateInputSchema);

export type OrganizationDoc = MutableDeep<Schema.Schema.Type<typeof OrganizationDocSchema>>;
export type OrganizationCreateInput = MutableDeep<Schema.Schema.Type<typeof OrganizationCreateInputSchema>>;
export type OrganizationApiCreateInput = MutableDeep<Schema.Schema.Type<typeof OrganizationApiCreateInputSchema>>;
export type OrganizationApiUpdateInput = MutableDeep<Schema.Schema.Type<typeof OrganizationApiUpdateInputSchema>>;
export type OrganizationUpdateInput = MutableDeep<Schema.Schema.Type<typeof OrganizationUpdateInputSchema>>;
