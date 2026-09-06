import { expect, test } from "bun:test";
import { Cause, Effect } from "effect";
import { classifyMongoError } from "../classify-mongo.ts";
import {
  PersistenceConflictError,
  PersistenceDataError,
  PersistenceDuplicateKeyError,
  PersistenceTimeoutError,
  PersistenceUnavailableError,
  SystemError,
} from "../families.ts";
import { SAFE_MESSAGES } from "../safe-messages.ts";

/** Shape-based fake Mongo driver error (no real driver dependency). */
class FakeMongoError extends Error {
  override name: string;
  code?: number | undefined;
  errorLabels?: string[] | undefined;
  keyPattern?: Record<string, unknown> | undefined;
  keyValue?: Record<string, unknown> | undefined;
  /** Test fault-adapter marker read by the classifier. */
  kind?: string | undefined;

  constructor(
    message: string,
    opts: {
      name?: string | undefined;
      code?: number | undefined;
      errorLabels?: string[] | undefined;
      keyPattern?: Record<string, unknown> | undefined;
      keyValue?: Record<string, unknown> | undefined;
      kind?: string | undefined;
    } = {},
  ) {
    super(message);
    this.name = opts.name ?? "MongoServerError";
    this.code = opts.code;
    this.errorLabels = opts.errorLabels;
    this.keyPattern = opts.keyPattern;
    this.keyValue = opts.keyValue;
    this.kind = opts.kind;
  }
}

// ---------------------------------------------------------------------------
// Duplicate key → PersistenceDuplicateKeyError
// ---------------------------------------------------------------------------

test("classifyMongoError: code 11000 → PersistenceDuplicateKeyError with never retry", () => {
  const err = new FakeMongoError(
    'E11000 duplicate key error collection app.customers index: email_1 dup key: { email: "a@b.c" }',
    { code: 11000 },
  );
  const result = classifyMongoError(err);
  expect(result).toBeInstanceOf(PersistenceDuplicateKeyError);
  if (!(result instanceof PersistenceDuplicateKeyError)) return;
  expect(result._tag).toBe("PersistenceDuplicateKeyError");
  expect(result.code).toBe("persistence_duplicate_key");
  expect(result.message).toBe(SAFE_MESSAGES.persistence_duplicate_key);
  expect(result.retryClass).toBe("never");
});

test("classifyMongoError: duplicate key indexName comes from keyPattern field names", () => {
  const result = classifyMongoError(
    new FakeMongoError("E11000 duplicate key error", {
      code: 11000,
      keyPattern: { email: 1, tenantId: 1 },
      keyValue: { email: "secret-user@example.com", tenantId: "org_123" },
    }),
  );
  expect(result).toBeInstanceOf(PersistenceDuplicateKeyError);
  if (!(result instanceof PersistenceDuplicateKeyError)) return;
  expect(result.indexName).toBe("email,tenantId");
  // PII from keyValue must never leak into the classified error.
  expect(result.indexName).not.toContain("@");
  expect(result.message).not.toContain("example.com");
  expect(result.fields).toBeUndefined();
});

test("classifyMongoError: MongoServerError name with E11000 message but no code → duplicate key", () => {
  const err = new FakeMongoError(
    "E11000 duplicate key error collection app.api_keys index: prefix_1",
  );
  err.code = undefined;
  const result = classifyMongoError(err);
  expect(result).toBeInstanceOf(PersistenceDuplicateKeyError);
  if (!(result instanceof PersistenceDuplicateKeyError)) return;
  expect(result.indexName).toBe("prefix_1");
});

test("classifyMongoError: duplicate key without extractable index has no indexName", () => {
  const result = classifyMongoError(new FakeMongoError("E11000 duplicate key", { code: 11000 }));
  expect(result).toBeInstanceOf(PersistenceDuplicateKeyError);
  if (!(result instanceof PersistenceDuplicateKeyError)) return;
  expect(result.indexName).toBeUndefined();
});

test("classifyMongoError: duplicate key wins over other fault markers (checked first)", () => {
  const err = new FakeMongoError("E11000 duplicate key after a timeout", {
    code: 11000,
    kind: "timeout",
  });
  const result = classifyMongoError(err);
  expect(result).toBeInstanceOf(PersistenceDuplicateKeyError);
});

test("classifyMongoError: duplicate key classification survives an Effect typed failure", async () => {
  const classified = classifyMongoError(
    new FakeMongoError("E11000 duplicate key error", { code: 11000 }),
  );
  const exit = await Effect.runPromiseExit(Effect.fail(classified));
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") return;
  const squashed = Cause.squash(exit.cause);
  expect(squashed).toBeInstanceOf(PersistenceDuplicateKeyError);
});

// ---------------------------------------------------------------------------
// Write conflict / transient label → PersistenceConflictError
// ---------------------------------------------------------------------------

test("classifyMongoError: write conflict code 112 → PersistenceConflictError", () => {
  const result = classifyMongoError(
    new FakeMongoError("Write conflict during plan execution and yield", { code: 112 }),
  );
  expect(result).toBeInstanceOf(PersistenceConflictError);
  if (!(result instanceof PersistenceConflictError)) return;
  expect(result.code).toBe("persistence_conflict");
  expect(result.message).toBe(SAFE_MESSAGES.persistence_conflict);
  expect(result.retryClass).toBe("transient");
  expect(result.labels).toEqual([]);
});

test("classifyMongoError: TransientTransactionError label → PersistenceConflictError with labels passthrough", () => {
  const result = classifyMongoError(
    new FakeMongoError("transaction aborted", {
      code: 251,
      errorLabels: ["TransientTransactionError", "RetryableWriteError"],
    }),
  );
  expect(result).toBeInstanceOf(PersistenceConflictError);
  if (!(result instanceof PersistenceConflictError)) return;
  expect(result.retryClass).toBe("transient");
  expect(result.labels).toEqual(["TransientTransactionError", "RetryableWriteError"]);
});

test("classifyMongoError: conflict beats network-family signals", () => {
  const err = new FakeMongoError("connection refused mid-write", {
    code: 112,
    name: "MongoNetworkError",
  });
  const result = classifyMongoError(err);
  expect(result).toBeInstanceOf(PersistenceConflictError);
});

// ---------------------------------------------------------------------------
// Timeout family → PersistenceTimeoutError
// ---------------------------------------------------------------------------

test("classifyMongoError: MongoNetworkTimeoutError → PersistenceTimeoutError, not unavailable", () => {
  const result = classifyMongoError(
    new FakeMongoError("network timeout while waiting for socket data", {
      name: "MongoNetworkTimeoutError",
    }),
  );
  expect(result).toBeInstanceOf(PersistenceTimeoutError);
  if (!(result instanceof PersistenceTimeoutError)) return;
  expect(result.code).toBe("persistence_timeout");
  expect(result.message).toBe(SAFE_MESSAGES.persistence_timeout);
  expect(result.retryClass).toBe("transient");
  expect(result.diagnostic).toContain("network timeout");
});

test("classifyMongoError: driver code 50 (ExceededTimeLimit) → PersistenceTimeoutError", () => {
  const result = classifyMongoError(
    new FakeMongoError("operation exceeded time limit", { code: 50 }),
  );
  expect(result).toBeInstanceOf(PersistenceTimeoutError);
});

test("classifyMongoError: MongoServerError with timeout message → PersistenceTimeoutError", () => {
  const result = classifyMongoError(
    new FakeMongoError("Command execution timed out after 30000ms"),
  );
  expect(result).toBeInstanceOf(PersistenceTimeoutError);
});

test("classifyMongoError: fault-adapter kind 'timeout' → PersistenceTimeoutError", () => {
  const result = classifyMongoError(new FakeMongoError("stuck", { kind: "timeout" }));
  expect(result).toBeInstanceOf(PersistenceTimeoutError);
});

// ---------------------------------------------------------------------------
// Network family → PersistenceUnavailableError
// ---------------------------------------------------------------------------

test("classifyMongoError: MongoNetworkError → PersistenceUnavailableError", () => {
  const result = classifyMongoError(
    new FakeMongoError("connection closed", { name: "MongoNetworkError" }),
  );
  expect(result).toBeInstanceOf(PersistenceUnavailableError);
  if (!(result instanceof PersistenceUnavailableError)) return;
  expect(result.code).toBe("persistence_unavailable");
  expect(result.message).toBe(SAFE_MESSAGES.persistence_unavailable);
  expect(result.retryClass).toBe("transient");
  expect(result.diagnostic).toBe("connection closed");
});

test("classifyMongoError: MongoServerSelectionError → PersistenceUnavailableError", () => {
  const result = classifyMongoError(
    new FakeMongoError("connection to server closed", { name: "MongoServerSelectionError" }),
  );
  expect(result).toBeInstanceOf(PersistenceUnavailableError);
});

test("classifyMongoError: generic Error with ECONNREFUSED message → PersistenceUnavailableError", () => {
  const err = new Error("connect ECONNREFUSED 127.0.0.1:27017");
  const result = classifyMongoError(err);
  expect(result).toBeInstanceOf(PersistenceUnavailableError);
});

test("classifyMongoError: fault-adapter kind 'unavailable' → PersistenceUnavailableError", () => {
  const result = classifyMongoError(new FakeMongoError("pool drained", { kind: "unavailable" }));
  expect(result).toBeInstanceOf(PersistenceUnavailableError);
});

// ---------------------------------------------------------------------------
// Invalid stored data → PersistenceDataError
// ---------------------------------------------------------------------------

test("classifyMongoError: BSONError → PersistenceDataError with never retry", () => {
  const result = classifyMongoError(
    new FakeMongoError("invalid bson", { name: "BSONError" }),
  );
  expect(result).toBeInstanceOf(PersistenceDataError);
  if (!(result instanceof PersistenceDataError)) return;
  expect(result.code).toBe("persistence_data");
  expect(result.retryClass).toBe("never");
});

test("classifyMongoError: validation-failure message → PersistenceDataError", () => {
  const result = classifyMongoError(
    new FakeMongoError("document failed validation", { code: 121 }),
  );
  expect(result).toBeInstanceOf(PersistenceDataError);
});

// ---------------------------------------------------------------------------
// Unknown → SystemError wrapping original
// ---------------------------------------------------------------------------

test("classifyMongoError: plain non-Mongo Error → SystemError with diagnostic passthrough", () => {
  const result = classifyMongoError(new TypeError("cannot read properties of undefined"));
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result._tag).toBe("SystemError");
  expect(result.code).toBe("system_error");
  expect(result.message).toBe(SAFE_MESSAGES.system_error);
  expect(result.diagnostic).toBe("cannot read properties of undefined");
});

test("classifyMongoError: unclassified Mongo-named error stays a SystemError defect", () => {
  const result = classifyMongoError(
    new FakeMongoError("bulk write failed for reason 42", { name: "MongoBulkWriteError", code: 42 }),
  );
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic).toContain("bulk write failed");
});

test("classifyMongoError: Mongo-shaped plain object (not an Error) → SystemError", () => {
  const shape = { name: "MongoServerError", code: 11600, message: "interrupted at shutdown" };
  const result = classifyMongoError(shape);
  expect(result).toBeInstanceOf(SystemError);
});

test("classifyMongoError: null input → SystemError, no throw", () => {
  const result = classifyMongoError(null);
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic).toBe("null");
});

test("classifyMongoError: undefined input → SystemError, no throw", () => {
  const result = classifyMongoError(undefined);
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic).toBe("undefined");
});

test("classifyMongoError: string input → SystemError echoing the string", () => {
  const result = classifyMongoError("kaboom");
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic).toBe("kaboom");
});

test("classifyMongoError: number input → SystemError via String coercion", () => {
  const result = classifyMongoError(1337);
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic).toBe("1337");
});

test("classifyMongoError: diagnostics are truncated to 500 chars", () => {
  const long = "x".repeat(600);
  const result = classifyMongoError(new TypeError(long));
  expect(result).toBeInstanceOf(SystemError);
  if (!(result instanceof SystemError)) return;
  expect(result.diagnostic?.length).toBe(500);
});
