import { test, expect } from "bun:test";
import { isDuplicateKeyError } from "../crypto.ts";

class FakeMongoError extends Error {
  override name: string;
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "MongoServerError";
    this.code = code;
  }
}

test("isDuplicateKeyError: true for Mongo code 11000", () => {
  expect(isDuplicateKeyError(new FakeMongoError("E11000 duplicate key", 11000))).toBe(true);
});

test("isDuplicateKeyError: true for MongoServerError with E11000 in message but missing code", () => {
  const err = new FakeMongoError("E11000 duplicate key error index");
  err.code = undefined;
  expect(isDuplicateKeyError(err)).toBe(true);
});

test("isDuplicateKeyError: false for other Mongo errors", () => {
  expect(isDuplicateKeyError(new FakeMongoError("connection refused", 6))).toBe(false);
  expect(isDuplicateKeyError(new FakeMongoError("timeout"))).toBe(false);
});

test("isDuplicateKeyError: false for non-Error inputs", () => {
  expect(isDuplicateKeyError(null)).toBe(false);
  expect(isDuplicateKeyError(undefined)).toBe(false);
  expect(isDuplicateKeyError("string")).toBe(false);
  expect(isDuplicateKeyError({ code: 11000 })).toBe(false);
});

test("isDuplicateKeyError: false for non-Mongo errors of any kind", () => {
  expect(isDuplicateKeyError(new TypeError("bad type"))).toBe(false);
  expect(isDuplicateKeyError(new RangeError("out of range"))).toBe(false);
});
