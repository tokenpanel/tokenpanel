/**
 * MongoDB driver error classifier (task 4.3).
 * Maps unknown throws into persistence tagged errors or SystemError (defect-class).
 */

import { isDuplicateKeyError } from "../lib/crypto.ts";
import {
  PersistenceConflictError,
  PersistenceDataError,
  PersistenceDuplicateKeyError,
  PersistenceTimeoutError,
  PersistenceUnavailableError,
  SystemError,
  type PersistenceAppError,
} from "./families.ts";
import { SAFE_MESSAGES } from "./safe-messages.ts";

type MongoLike = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  errorLabels?: unknown;
  keyPattern?: unknown;
  keyValue?: unknown;
  /** Test fault-adapter marker (createMongoFault). */
  kind?: unknown;
};

function asMongoLike(err: unknown): MongoLike | null {
  if (typeof err !== "object" || err === null) return null;
  return err as MongoLike;
}

function errorLabelsOf(err: MongoLike): string[] {
  if (!Array.isArray(err.errorLabels)) return [];
  return err.errorLabels.filter((l): l is string => typeof l === "string");
}

function indexNameOf(err: MongoLike): string | undefined {
  // Never include keyValue (may hold PII/emails). Prefer keyPattern field names.
  if (err.keyPattern && typeof err.keyPattern === "object" && err.keyPattern !== null) {
    const keys = Object.keys(err.keyPattern as Record<string, unknown>);
    if (keys.length > 0) return keys.join(",");
  }
  if (typeof err.message === "string") {
    const m = err.message.match(/index:\s*([^\s]+)/i);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function nameOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  const m = asMongoLike(err);
  return typeof m?.name === "string" ? m.name : "";
}

/**
 * Labels that mean the transaction body is safe to re-run after abort.
 * UnknownTransactionCommitResult is intentionally excluded: commit may have
 * already succeeded, so callers must retry commit only (see withMongoSession).
 */
const TRANSIENT_LABELS = new Set(["TransientTransactionError"]);

const TIMEOUT_NAMES = new Set([
  "MongoNetworkTimeoutError",
  "MongoServerError", // only when message indicates timeout — checked separately
  "MongoExpiredSessionError",
  "MongoOperationTimeoutError",
]);

const UNAVAILABLE_NAMES = new Set([
  "MongoServerSelectionError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoNetworkError",
]);

function isTimeout(err: unknown, mongo: MongoLike): boolean {
  const name = nameOf(err);
  const msg = messageOf(err).toLowerCase();
  if (name === "MongoNetworkTimeoutError" || name === "MongoExpiredSessionError") {
    return true;
  }
  if (name === "MongoOperationTimeoutError") return true;
  if (TIMEOUT_NAMES.has(name) && /timed?\s*out|timeout|exceeded time/i.test(msg)) {
    return true;
  }
  // Driver code 50 = ExceededTimeLimit (optional)
  if (mongo.code === 50) return true;
  if (mongo.kind === "timeout") return true;
  return /operation timed out|socket timeout|network timeout/i.test(msg);
}

function isUnavailable(err: unknown, mongo: MongoLike): boolean {
  const name = nameOf(err);
  if (UNAVAILABLE_NAMES.has(name)) return true;
  if (mongo.kind === "unavailable") return true;
  const msg = messageOf(err).toLowerCase();
  return (
    /topology destroyed|server selection|not connected|connection refused|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(
      msg,
    ) || /MongoServerSelection/i.test(name)
  );
}

function isInvalidData(err: unknown, mongo: MongoLike): boolean {
  const name = nameOf(err);
  if (name === "PersistenceDataError" || name === "BSONError" || name === "BSONTypeError") {
    return true;
  }
  if (mongo.kind === "corrupt") return true;
  const msg = messageOf(err).toLowerCase();
  return /corrupt|invalid bson|cannot parse|schema validation failed|document failed validation/i.test(
    msg,
  );
}

/**
 * Classify a MongoDB (or Mongo-like) failure into a tagged persistence error.
 * Unclassifiable values become SystemError (treat as defect at the boundary).
 */
export function classifyMongoError(
  err: unknown,
): PersistenceAppError | SystemError {
  if (isDuplicateKeyError(err)) {
    const mongo = asMongoLike(err) ?? {};
    const indexName = indexNameOf(mongo);
    return new PersistenceDuplicateKeyError({
      code: "persistence_duplicate_key",
      message: SAFE_MESSAGES.persistence_duplicate_key,
      ...(indexName !== undefined ? { indexName } : {}),
      retryClass: "never",
    });
  }

  const mongo = asMongoLike(err);
  if (!mongo) {
    return new SystemError({
      code: "system_error",
      message: SAFE_MESSAGES.internal_server_error,
      diagnostic: messageOf(err).slice(0, 500),
    });
  }

  const labels = errorLabelsOf(mongo);
  const hasTransientLabel = labels.some((l) => TRANSIENT_LABELS.has(l));
  // WriteConflict
  if (mongo.code === 112 || hasTransientLabel) {
    return new PersistenceConflictError({
      code: "persistence_conflict",
      message: SAFE_MESSAGES.persistence_conflict,
      labels,
      retryClass: "transient",
    });
  }

  if (isTimeout(err, mongo)) {
    return new PersistenceTimeoutError({
      code: "persistence_timeout",
      message: SAFE_MESSAGES.persistence_timeout,
      retryClass: "transient",
      diagnostic: messageOf(err).slice(0, 500),
    });
  }

  if (isUnavailable(err, mongo)) {
    return new PersistenceUnavailableError({
      code: "persistence_unavailable",
      message: SAFE_MESSAGES.persistence_unavailable,
      retryClass: "transient",
      diagnostic: messageOf(err).slice(0, 500),
    });
  }

  if (isInvalidData(err, mongo)) {
    return new PersistenceDataError({
      code: "persistence_data",
      message: SAFE_MESSAGES.persistence_data,
      retryClass: "never",
      diagnostic: messageOf(err).slice(0, 500),
    });
  }

  // Named Mongo errors we don't specially classify still stay as system/defect.
  const name = nameOf(err);
  if (name.startsWith("Mongo") || name === "MongoError" || name === "MongoServerError") {
    return new SystemError({
      code: "system_error",
      message: SAFE_MESSAGES.internal_server_error,
      diagnostic: messageOf(err).slice(0, 500),
    });
  }

  return new SystemError({
    code: "system_error",
    message: SAFE_MESSAGES.internal_server_error,
    diagnostic: messageOf(err).slice(0, 500),
  });
}
