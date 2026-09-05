import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { CustomerListQuery } from "../query.ts";

const decode = (raw: unknown) =>
  Schema.decodeUnknownSync(CustomerListQuery)(raw);

describe("CustomerListQuery email filter", () => {
  test("lowercases the email like stored customer emails", () => {
    const q = decode({ email: "ADA@Example.COM" });
    expect(q.email).toBe("ada@example.com");
  });

  test("accepts a 254-character email (q's 160-char cap does not apply)", () => {
    const email = `${"a".repeat(242)}@example.com`;
    expect(email.length).toBe(254);
    expect(decode({ email }).email).toBe(email);
  });

  test("rejects a 255-character email", () => {
    const email = `${"a".repeat(243)}@example.com`;
    expect(email.length).toBe(255);
    expect(() => decode({ email })).toThrow();
  });

  test("rejects malformed emails", () => {
    expect(() => decode({ email: "not-an-email" })).toThrow();
    expect(() => decode({ email: "a@b" })).toThrow();
  });

  test("email composes with q and status filters", () => {
    const q = decode({ email: "ada@example.com", q: "ada", status: "active" });
    expect(q.email).toBe("ada@example.com");
    expect(q.q).toBe("ada");
    expect(q.status).toBe("active");
  });

  test("q keeps its 160-char bound; email stays optional", () => {
    expect(decode({ q: "a".repeat(160) }).q).toBe("a".repeat(160));
    expect(() => decode({ q: "a".repeat(161) })).toThrow();
    expect(decode({}).email).toBeUndefined();
  });
});
