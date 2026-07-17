/**
 * Organization Effect schemas.
 */
import { Schema } from "effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  TimestampFields,
  CurrencyCode,
  Slug,
  exactOptional,
  boundedString,
} from "./primitives.ts";

const OrgName = boundedString(1, 120);

export const OrganizationDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  name: OrgName,
  slug: Slug,
  ownerId: ObjectIdFromSelf,
  defaultCurrency: CurrencyCode,
  ...TimestampFields,
});

export const OrganizationCreateInput = Schema.Struct({
  name: OrgName,
  slug: Slug,
  ownerId: ObjectIdFromString,
  defaultCurrency: CurrencyCode,
});

export const OrganizationApiCreateInput = Schema.Struct({
  name: OrgName,
  slug: exactOptional(Slug),
  defaultCurrency: exactOptional(CurrencyCode),
});

export const OrganizationApiUpdateInput = Schema.Struct({
  name: exactOptional(OrgName),
  slug: exactOptional(Slug),
  defaultCurrency: exactOptional(CurrencyCode),
});

/** Persistence patch (owner transfer + api fields). */
export const OrganizationUpdateInput = Schema.Struct({
  name: exactOptional(OrgName),
  slug: exactOptional(Slug),
  defaultCurrency: exactOptional(CurrencyCode),
  ownerId: exactOptional(ObjectIdFromSelf),
});

export type OrganizationDoc = Schema.Schema.Type<typeof OrganizationDoc>;
export type OrganizationCreateInput = Schema.Schema.Type<
  typeof OrganizationCreateInput
>;
export type OrganizationApiCreateInput = Schema.Schema.Type<
  typeof OrganizationApiCreateInput
>;
export type OrganizationApiUpdateInput = Schema.Schema.Type<
  typeof OrganizationApiUpdateInput
>;
export type OrganizationUpdateInput = Schema.Schema.Type<
  typeof OrganizationUpdateInput
>;
