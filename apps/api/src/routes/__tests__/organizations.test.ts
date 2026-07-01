import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { deriveSlug, toResponse } from "../organizations.ts";
import type { OrganizationDoc } from "@tokenpanel/db";

test("deriveSlug: lowercase + hyphenate + trim punctuation", () => {
  expect(deriveSlug("Acme Inc.")).toBe("acme-inc");
  expect(deriveSlug("  My   Cool Org! ")).toBe("my-cool-org");
  expect(deriveSlug("UPPER_CASE")).toBe("upper-case");
  expect(deriveSlug("a.b,c;d_e")).toBe("a-b-c-d-e");
});

test("deriveSlug: falls back to 'org' when name yields empty slug", () => {
  expect(deriveSlug("!!!")).toBe("org");
  expect(deriveSlug("---")).toBe("org");
  expect(deriveSlug("")).toBe("org");
});

test("toResponse: maps ObjectId + Dates to strings, preserves scalar fields", () => {
  const now = new Date();
  const ownerId = new ObjectId();
  const orgId = new ObjectId();
  const doc: OrganizationDoc = {
    _id: orgId,
    name: "Acme",
    slug: "acme",
    ownerId,
    defaultCurrency: "USD",
    createdAt: now,
    updatedAt: now,
  };
  const r = toResponse(doc);
  expect(r.id).toBe(orgId.toHexString());
  expect(r.ownerId).toBe(ownerId.toHexString());
  expect(r.name).toBe("Acme");
  expect(r.slug).toBe("acme");
  expect(r.defaultCurrency).toBe("USD");
  expect(r.createdAt).toBe(now.toISOString());
  expect(r.updatedAt).toBe(now.toISOString());
});
