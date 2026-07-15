import { test, expect } from "bun:test";
import { ObjectId } from "mongodb";
import { parseObjectIdParam, escapeRegExp } from "../route-utils.ts";

test("parseObjectIdParam: valid hex → ObjectId", () => {
  const hex = new ObjectId().toHexString();
  const oid = parseObjectIdParam(hex);
  expect(oid).toBeInstanceOf(ObjectId);
  expect(oid!.toHexString()).toBe(hex);
});

test("parseObjectIdParam: invalid → null", () => {
  expect(parseObjectIdParam("bad")).toBeNull();
  expect(parseObjectIdParam("")).toBeNull();
  expect(parseObjectIdParam("zzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
});

test("escapeRegExp: escapes metacharacters", () => {
  expect(escapeRegExp("a.b*c?")).toBe("a\\.b\\*c\\?");
  expect(new RegExp(`^${escapeRegExp("foo.bar")}$`).test("foo.bar")).toBe(true);
  expect(new RegExp(`^${escapeRegExp("foo.bar")}$`).test("fooXbar")).toBe(false);
});
