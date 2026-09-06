/**
 * Safe public messages (task 4.9): stable messages, no raw infra/JWT/crypto leaks.
 * Pure sync functions — no repos, no DB, no runtime.
 */
import { describe, expect, test } from "bun:test";
import {
  JWT_PUBLIC_REASON,
  SAFE_MESSAGES,
  classifyJwtMessage,
  looksLikeUnsafeDiagnostic,
  publicMessageForCode,
} from "../safe-messages.ts";

describe("classifyJwtMessage", () => {
  test("maps each known private cause distinctly", () => {
    expect(classifyJwtMessage("expired").privateReason).toBe("expired");
    expect(classifyJwtMessage("bad signature").privateReason).toBe("bad signature");
    expect(classifyJwtMessage("malformed jwt").privateReason).toBe("malformed jwt");
    expect(classifyJwtMessage("unsupported alg").privateReason).toBe("unsupported alg");
    expect(classifyJwtMessage("malformed payload").privateReason).toBe("malformed payload");
    expect(classifyJwtMessage("bad subject").privateReason).toBe("bad subject");
  });

  test("unknown raw text collapses to generic jwt_error", () => {
    expect(classifyJwtMessage("JWE verification failed at jose").privateReason).toBe("jwt_error");
    expect(classifyJwtMessage("").privateReason).toBe("jwt_error");
  });

  test("public surface stays generic: same code, message, undefined reason", () => {
    const raws = [
      "expired",
      "bad signature",
      "malformed jwt",
      "unsupported alg",
      "malformed payload",
      "bad subject",
      "JWE verification failed at jose",
    ];
    for (const raw of raws) {
      const c = classifyJwtMessage(raw);
      expect(c.code).toBe("unauthorized");
      expect(c.publicReason).toBeUndefined();
      expect(c.message).toBe(SAFE_MESSAGES.unauthorized);
    }
    expect(JWT_PUBLIC_REASON).toBe("unauthorized");
  });

  test("raw driver/JWT error text is never echoed to clients", () => {
    const leaky =
      'JWSProtectedHeaderInvalid: secret "hunter2" at mongodb+srv://cluster.example.com';
    const c = classifyJwtMessage(leaky);
    expect(c.message).toBe(SAFE_MESSAGES.unauthorized);
    expect(c.message.includes("hunter2")).toBe(false);
    expect(c.message.includes("mongodb")).toBe(false);
  });
});

describe("publicMessageForCode", () => {
  test("returns the stable safe message for every known code", () => {
    for (const [code, message] of Object.entries(SAFE_MESSAGES)) {
      expect(publicMessageForCode(code, undefined)).toBe(message);
    }
  });

  test("unknown code defaults to internal_server_error", () => {
    expect(publicMessageForCode("totally_unknown_code")).toBe(
      SAFE_MESSAGES.internal_server_error,
    );
    expect(publicMessageForCode("totally_unknown_code", undefined)).toBe(
      SAFE_MESSAGES.internal_server_error,
    );
  });

  test("keeps clean short product-owned candidates", () => {
    expect(publicMessageForCode("insufficient_balance", "Balance too low for this model")).toBe(
      "Balance too low for this model",
    );
  });

  test("falls back to the safe message on unsafe or oversized candidates", () => {
    const leaky = "connection failed: ECONNREFUSED 10.0.0.5:27017";
    expect(publicMessageForCode("provider_unavailable", leaky)).toBe(
      SAFE_MESSAGES.provider_unavailable,
    );
    const oversized = "x".repeat(301);
    expect(publicMessageForCode("insufficient_balance", oversized)).toBe(
      SAFE_MESSAGES.insufficient_balance,
    );
    expect(publicMessageForCode("insufficient_balance", "x".repeat(300))).toBe(
      "x".repeat(300),
    );
  });

  test("never returns a candidate that leaks infrastructure details", () => {
    const leaks = [
      "mongodb+srv://admin:s3cret@cluster0.abc12.mongodb.net/tok-panel",
      "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig",
      "api_key=sk-proj0123456789abcdef at Function.fetch (node:internal:undici:1:1)",
      "at Object.handler (/app/src/http/server.ts:42:15)",
      "MongoServerError: not primary on rs0/shard0.internal:27017",
    ];
    for (const leak of leaks) {
      for (const code of ["provider_unavailable", "internal_server_error", "unknown_code"]) {
        const out = publicMessageForCode(code, leak);
        expect(out).not.toBe(leak);
        expect(looksLikeUnsafeDiagnostic(out)).toBe(false);
      }
    }
  });
});

describe("looksLikeUnsafeDiagnostic", () => {
  test("flags connection, stack, credential, and key leaks", () => {
    const flagged = [
      "connect ECONNREFUSED 127.0.0.1:5432",
      "getaddrinfo ENOTFOUND api.provider.com",
      "socket hang up ECONNRESET",
      "MongoServerSelectionError: connection timed out",
      "at handler (/app/src/x.ts:1:1)",
      "mongodb://root:pw@db.internal:27017",
      "Authorization: Bearer abc.def.ghi",
      "password=hunter2",
      "openai secret: sk-abcdefghijklmnop",
    ];
    for (const text of flagged) {
      expect(looksLikeUnsafeDiagnostic(text)).toBe(true);
    }
  });

  test("passes ordinary product messages", () => {
    const clean = [
      "Insufficient balance to complete request",
      "Customer balance currency does not match model currency",
      "Model has no active provider entries",
      "Provider request timed out after retries",
    ];
    for (const text of clean) {
      expect(looksLikeUnsafeDiagnostic(text)).toBe(false);
    }
  });
});
