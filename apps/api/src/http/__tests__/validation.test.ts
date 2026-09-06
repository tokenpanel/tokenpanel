/**
 * Tests for http/validation (Effect Schema Hono validators).
 *
 * Covers the four exported validators via observable outcomes:
 * - decodeToValidationResult: success/failure shaping, issue paths, flatten()
 * - safeParseSchema: both branches
 * - parseSchema: accept + throw-on-reject
 * - sValidator: tiny Hono apps per target (json/query), 400 default, hook
 *   overrides (422 / success interception), excess-key policy, sanitization
 *   of sensitive fields.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Schema } from "effect";
import {
  decodeToValidationResult,
  parseSchema,
  safeParseSchema,
  sValidator,
} from "../validation/index.ts";

const ProfileBody = Schema.Struct({ name: Schema.String, age: Schema.Number });
const NestedBody = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const SecretBody = Schema.Struct({ password: Schema.String });
const SearchQuery = Schema.Struct({ q: Schema.String });

const JSON_HEADERS = { "content-type": "application/json" };

const validationApp = new Hono();

validationApp.post(
  "/profile",
  sValidator("json", ProfileBody),
  (c) => c.json({ ok: true, body: c.req.valid("json") }),
);
validationApp.post(
  "/nested",
  sValidator("json", NestedBody),
  (c) => c.json({ ok: true, body: c.req.valid("json") }),
);
validationApp.post(
  "/secret",
  sValidator("json", SecretBody),
  (c) => c.json({ ok: true, body: c.req.valid("json") }),
);
validationApp.get(
  "/search",
  sValidator("query", SearchQuery),
  (c) => c.json({ ok: true, body: c.req.valid("query") }),
);
validationApp.post(
  "/hooked",
  sValidator("json", ProfileBody, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: "validation_error", details: result.error.flatten().fieldErrors },
        422,
      );
    }
  }),
  (c) => c.json({ ok: true, body: c.req.valid("json") }),
);
validationApp.post(
  "/intercept",
  sValidator("json", SecretBody, (result, c) => {
    if (result.success) {
      return c.json({ intercepted: true, data: result.data });
    }
  }),
  (c) => c.json({ ok: true, body: c.req.valid("json") }),
);

describe("decodeToValidationResult", () => {
  test("accepts a valid body and returns the decoded data", () => {
    const result = decodeToValidationResult(ProfileBody, { name: "ada", age: 36 });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "ada", age: 36 });
    }
  });

  test("strips unknown keys under the default excess-property policy", () => {
    const result = decodeToValidationResult(ProfileBody, {
      name: "ada",
      age: 36,
      isAdmin: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "ada", age: 36 });
      expect("isAdmin" in result.data).toBe(false);
    }
  });

  test("rejects a wrong-typed field with a path + message issue", () => {
    const result = decodeToValidationResult(ProfileBody, { name: 42, age: 36 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe("ParseError");
      expect(result.error.issues[0]?.path).toEqual(["name"]);
      expect(result.error.issues[0]?.message).toContain("Expected string");
    }
  });

  test("rejects a missing field with a path + message issue", () => {
    const result = decodeToValidationResult(ProfileBody, { name: "ada" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["age"]);
      expect(result.error.issues[0]?.message).toContain("missing");
    }
  });

  test("reports nested paths via dot-walked path arrays", () => {
    const result = decodeToValidationResult(NestedBody, { user: { email: 1 } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["user", "email"]);
    }
  });

  test("masks rejected values on sensitive paths", () => {
    const result = decodeToValidationResult(SecretBody, { password: 42 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["password"]);
      expect(result.error.issues[0]?.message).toBe("Invalid value");
    }
  });

  test("rejects non-object input at the root path", () => {
    const result = decodeToValidationResult(ProfileBody, "nope");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });

  test("flatten() splits root issues into formErrors and field issues into fieldErrors", () => {
    const root = decodeToValidationResult(ProfileBody, "nope");
    expect(root.success).toBe(false);
    if (!root.success) {
      const flattened = root.error.flatten();
      expect(flattened.formErrors.length).toBe(1);
      expect(flattened.fieldErrors).toEqual({});
    }

    const field = decodeToValidationResult(ProfileBody, { name: 42 });
    expect(field.success).toBe(false);
    if (!field.success) {
      const flattened = field.error.flatten();
      expect(flattened.formErrors).toEqual([]);
      expect(flattened.fieldErrors.name?.length).toBe(1);
      expect(flattened.fieldErrors.name?.[0]).toContain("Expected string");
    }
  });

  test("flatten() sanitizes sensitive field errors", () => {
    const result = decodeToValidationResult(SecretBody, { password: 42 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors).toEqual({
        password: ["Invalid value"],
      });
    }
  });
});

describe("safeParseSchema", () => {
  test("returns success + data on the accept branch", () => {
    const result = safeParseSchema(ProfileBody, { name: "ada", age: 36 });

    expect(result).toEqual({ success: true, data: { name: "ada", age: 36 } });
  });

  test("returns ParseError failure on the reject branch", () => {
    const result = safeParseSchema(ProfileBody, { name: "ada" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.name).toBe("ParseError");
      expect(result.error.issues[0]?.path).toEqual(["age"]);
    }
  });
});

describe("parseSchema", () => {
  test("returns the decoded value on accept", () => {
    expect(parseSchema(ProfileBody, { name: "ada", age: 36 })).toEqual({
      name: "ada",
      age: 36,
    });
  });

  test("throws on reject", () => {
    expect(() => parseSchema(ProfileBody, { name: 42 })).toThrow(/Expected string/);
  });
});

describe("sValidator json target", () => {
  test("valid body reaches the handler with the parsed value", async () => {
    const res = await validationApp.request("/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "ada", age: 36 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { name: "ada", age: 36 } });
  });

  test("missing field returns 400 with a ParseError issue array", async () => {
    const res = await validationApp.request("/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "ada" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      error: { name: string; issues: { path: string[]; message: string }[] };
    };
    expect(body.success).toBe(false);
    expect(body.error.name).toBe("ParseError");
    expect(body.error.issues[0]?.path).toEqual(["age"]);
    expect(body.error.issues[0]?.message.length).toBeGreaterThan(0);
  });

  test("wrong type returns 400 with path + message", async () => {
    const res = await validationApp.request("/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 42, age: 36 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { issues: { path: string[]; message: string }[] };
    };
    expect(body.error.issues[0]?.path).toEqual(["name"]);
    expect(body.error.issues[0]?.message).toContain("Expected string");
  });

  test("unknown extra keys are accepted and stripped per the default policy", async () => {
    const res = await validationApp.request("/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "ada", age: 36, isAdmin: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { name: "ada", age: 36 } });
  });

  test("malformed JSON returns the hono 400 text response", async () => {
    const res = await validationApp.request("/profile", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{oops",
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Malformed JSON in request body");
  });

  test("nested failures surface the full path array", async () => {
    const res = await validationApp.request("/nested", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ user: { email: 1 } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { issues: { path: string[] }[] };
    };
    expect(body.error.issues[0]?.path).toEqual(["user", "email"]);
  });

  test("sensitive fields never echo rejected values", async () => {
    const res = await validationApp.request("/secret", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: 42 }),
    });

    expect(res.status).toBe(400);
    const raw = JSON.stringify(await res.json());
    expect(raw).toContain("Invalid value");
    expect(raw).not.toContain("42");
  });
});

describe("sValidator query target", () => {
  test("valid query reaches the handler with the parsed value", async () => {
    const res = await validationApp.request("/search?q=abc");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, body: { q: "abc" } });
  });

  test("missing query param returns 400 with a path + message issue", async () => {
    const res = await validationApp.request("/search");

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { issues: { path: string[]; message: string }[] };
    };
    expect(body.error.issues[0]?.path).toEqual(["q"]);
    expect(body.error.issues[0]?.message).toContain("missing");
  });
});

describe("sValidator hook", () => {
  test("hook failure response (422 field errors) takes precedence over the default 400", async () => {
    const res = await validationApp.request("/hooked", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 42 }),
    });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "validation_error",
      details: { name: [expect.stringContaining("Expected string")] },
    });
  });

  test("hook without a failure response falls through to the default 400", async () => {
    const res = await validationApp.request("/intercept", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: 42 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  test("hook response on success intercepts the handler", async () => {
    const res = await validationApp.request("/intercept", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: "hunter2" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      intercepted: true,
      data: { password: "hunter2" },
    });
  });
});
