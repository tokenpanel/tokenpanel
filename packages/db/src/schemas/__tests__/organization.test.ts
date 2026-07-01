import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import {
  organizationDoc,
  organizationCreateInput,
  organizationApiCreateInput,
  organizationApiUpdateInput,
} from "../organization.ts";

test("organizationCreateInput coerces valid ownerId string", () => {
  const hex = new ObjectId().toHexString();
  const r = organizationCreateInput.safeParse({
    name: "Acme",
    slug: "acme",
    ownerId: hex,
    defaultCurrency: "USD",
  });
  expect(r.success).toBe(true);
  if (r.success) expect(r.data.ownerId).toBeInstanceOf(ObjectId);
});

test("organizationCreateInput rejects invalid slug", () => {
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "Acme_Co",
      ownerId: new ObjectId().toHexString(),
      defaultCurrency: "USD",
    }).success,
  ).toBe(false);
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "UPPER",
      ownerId: new ObjectId().toHexString(),
      defaultCurrency: "USD",
    }).success,
  ).toBe(false);
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "",
      ownerId: new ObjectId().toHexString(),
      defaultCurrency: "USD",
    }).success,
  ).toBe(false);
});

test("organizationCreateInput rejects lowercase/2-letter currency", () => {
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "acme",
      ownerId: new ObjectId().toHexString(),
      defaultCurrency: "usd",
    }).success,
  ).toBe(false);
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "acme",
      ownerId: new ObjectId().toHexString(),
      defaultCurrency: "US",
    }).success,
  ).toBe(false);
});

test("organizationCreateInput rejects invalid ownerId string", () => {
  expect(
    organizationCreateInput.safeParse({
      name: "Acme",
      slug: "acme",
      ownerId: "not-an-id",
      defaultCurrency: "USD",
    }).success,
  ).toBe(false);
});

test("organizationDoc requires ObjectId _id + timestamps", () => {
  expect(
    organizationDoc.safeParse({
      _id: new ObjectId(),
      name: "Acme",
      slug: "acme",
      ownerId: new ObjectId(),
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(true);
  expect(
    organizationDoc.safeParse({
      _id: "507f1f77bcf86cd799439011",
      name: "Acme",
      slug: "acme",
      ownerId: new ObjectId(),
      defaultCurrency: "USD",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).success,
  ).toBe(false);
});

test("organizationCreateInput name bounds 1-120", () => {
  const base = { slug: "acme", ownerId: new ObjectId().toHexString(), defaultCurrency: "USD" };
  expect(organizationCreateInput.safeParse({ ...base, name: "" }).success).toBe(false);
  expect(organizationCreateInput.safeParse({ ...base, name: "x".repeat(121) }).success).toBe(false);
  expect(organizationCreateInput.safeParse({ ...base, name: "Acme" }).success).toBe(true);
});

test("organizationApiCreateInput: name required, slug + currency optional", () => {
  expect(organizationApiCreateInput.safeParse({ name: "Acme" }).success).toBe(true);
  expect(organizationApiCreateInput.safeParse({ name: "" }).success).toBe(false);
  expect(organizationApiCreateInput.safeParse({ name: "Acme", slug: "UPPER" }).success).toBe(false);
  expect(organizationApiCreateInput.safeParse({ name: "Acme", slug: "acme" }).success).toBe(true);
  expect(organizationApiCreateInput.safeParse({ name: "Acme", defaultCurrency: "usd" }).success).toBe(false);
  expect(organizationApiCreateInput.safeParse({ name: "Acme", defaultCurrency: "USD" }).success).toBe(true);
});

test("organizationApiUpdateInput: all optional, validates shapes when present", () => {
  expect(organizationApiUpdateInput.safeParse({}).success).toBe(true);
  expect(organizationApiUpdateInput.safeParse({ name: "X" }).success).toBe(true);
  expect(organizationApiUpdateInput.safeParse({ name: "" }).success).toBe(false);
  expect(organizationApiUpdateInput.safeParse({ slug: "BAD" }).success).toBe(false);
  expect(organizationApiUpdateInput.safeParse({ slug: "ok-slug" }).success).toBe(true);
  expect(organizationApiUpdateInput.safeParse({ defaultCurrency: "US" }).success).toBe(false);
});