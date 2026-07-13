import type { ObjectId } from "mongodb";
import type { MigrationDb } from "../../src/migrator/migration-db.ts";

/**
 * Immutable snapshot of the write-contract limits + newline helper.
 * Inlined on purpose: migration checksum covers this file only; importing
 * live schema constants would let future schema edits silently change
 * already-checksummed migration behavior.
 */
const METADATA_MAX_ENTRIES = 50;
const METADATA_VALUE_MAX_LEN = 2000;

/** CR/CRLF → LF (matches product write contract / textarea). */
function normalizeValueNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export const id = "2026-07-13T00-00-00Z__normalize-model-metadata";
export const phase = "post" as const;
export const transactional = true as const;

type ModelRow = {
  _id: ObjectId;
  aliasId?: string;
  metadata?: unknown;
};

/**
 * Assign a string property without invoking the `__proto__` setter.
 * Uses a null-prototype object so reserved keys round-trip as own properties.
 */
export function setOwnString(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** True for JSON-serializable plain objects (including null-proto). */
export function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hostObjectKind(value: object): string {
  if (value instanceof Date) return "Date";
  if (value instanceof RegExp) return "RegExp";
  if (typeof Map !== "undefined" && value instanceof Map) return "Map";
  if (typeof Set !== "undefined" && value instanceof Set) return "Set";
  return (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value;
}

/**
 * Walk arrays/objects and abort if any nested value is non-JSON BSON/host
 * (Date, ObjectId, Binary, RegExp, Map, …) or a non-finite number.
 */
export function assertJsonSafeTree(
  value: unknown,
  modelId: string,
  key: string,
  path: string,
): void {
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId} key "${key}" at ${path}: non-finite number (${String(value)})`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonSafeTree(value[i], modelId, key, `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId} key "${key}" at ${path}: unconvertible BSON value of type ${hostObjectKind(value)}`,
      );
    }
    for (const childKey of Reflect.ownKeys(value)) {
      if (typeof childKey !== "string") {
        throw new Error(
          `[migration:normalize-model-metadata] model ${modelId} key "${key}" at ${path}: non-string property key`,
        );
      }
      assertJsonSafeTree(
        (value as Record<string, unknown>)[childKey],
        modelId,
        key,
        `${path}.${childKey}`,
      );
    }
    return;
  }
  throw new Error(
    `[migration:normalize-model-metadata] model ${modelId} key "${key}" at ${path}: unconvertible value of type ${typeof value}`,
  );
}

/**
 * Convert a single legacy metadata value to a string.
 *
 * - Existing strings preserved with CR/CRLF → LF normalization
 * - Finite JSON primitives via String(...)
 * - Arrays and plain objects via deterministic JSON.stringify after recursive
 *   BSON + finite-number safety check
 * - Date / Map / RegExp / ObjectId / non-finite numbers abort
 */
export function convertLegacyMetadataValue(
  value: unknown,
  modelId: string,
  key: string,
): string {
  if (typeof value === "string") {
    return normalizeValueNewlines(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId} key "${key}": non-finite number (${String(value)})`,
      );
    }
    return String(value);
  }
  if (typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    assertJsonSafeTree(value, modelId, key, key);
    return JSON.stringify(value);
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId} key "${key}": unconvertible BSON value of type ${hostObjectKind(value)}`,
      );
    }
    assertJsonSafeTree(value, modelId, key, key);
    return JSON.stringify(value);
  }
  throw new Error(
    `[migration:normalize-model-metadata] model ${modelId} key "${key}": unconvertible value of type ${typeof value}`,
  );
}

/**
 * Normalize a model's metadata field to Record<string, string>.
 * Missing / undefined → {}.
 * Top-level must be a plain or null-prototype object (Date/Map/RegExp abort).
 * Keys are kept as-is (no rekeying); values converted per convertLegacyMetadataValue.
 * Aborts if the result would exceed the write contract (entry count / value length)
 * so migrated data always satisfies stored + write shapes.
 * Output is a null-prototype object so keys like `__proto__` round-trip.
 */
export function normalizeModelMetadata(
  metadata: unknown,
  modelId: string,
): { metadata: Record<string, string>; convertedValues: number } {
  if (metadata === undefined) {
    return { metadata: Object.create(null) as Record<string, string>, convertedValues: 0 };
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      `[migration:normalize-model-metadata] model ${modelId}: malformed non-object metadata (${metadata === null ? "null" : Array.isArray(metadata) ? "array" : typeof metadata})`,
    );
  }
  if (!isPlainObject(metadata)) {
    throw new Error(
      `[migration:normalize-model-metadata] model ${modelId}: malformed non-plain metadata (got ${hostObjectKind(metadata)}); expected plain object`,
    );
  }

  const out = Object.create(null) as Record<string, string>;
  let convertedValues = 0;
  // Reflect.ownKeys so own `__proto__` is not lost.
  for (const key of Reflect.ownKeys(metadata as object)) {
    if (typeof key !== "string") {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId}: non-string metadata key`,
      );
    }
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === "string") {
      const normalized = normalizeValueNewlines(value);
      setOwnString(out, key, normalized);
      if (normalized !== value) convertedValues += 1;
    } else {
      setOwnString(out, key, convertLegacyMetadataValue(value, modelId, key));
      convertedValues += 1;
    }
  }

  const keys = Reflect.ownKeys(out).filter((k): k is string => typeof k === "string");
  if (keys.length > METADATA_MAX_ENTRIES) {
    throw new Error(
      `[migration:normalize-model-metadata] model ${modelId}: metadata has ${keys.length} entries (max ${METADATA_MAX_ENTRIES}); reduce before re-running`,
    );
  }
  for (const key of keys) {
    const v = out[key]!;
    if (v.length > METADATA_VALUE_MAX_LEN) {
      throw new Error(
        `[migration:normalize-model-metadata] model ${modelId} key "${key}": value length ${v.length} exceeds max ${METADATA_VALUE_MAX_LEN}`,
      );
    }
  }

  return { metadata: out, convertedValues };
}

/**
 * Normalize every stored model.metadata map to Record<string, string>.
 *
 * Background: model.metadata previously accepted arbitrary JSON
 * (Record<string, unknown>). The product write contract is now bounded
 * string pairs only. New writes enforce this at the zod boundary; this
 * migration repairs EXISTING rows so storage matches the invariant.
 *
 * Phase = post: rewrites existing model documents (data conversion), so it
 * belongs in post/ — run by the manager after container swap where destructive
 * work is permitted. Applied state is tracked in `_migrations`.
 *
 * Behavior:
 *   - missing metadata → {}
 *   - top-level must be plain/null-proto object (Date/Map/RegExp abort)
 *   - string values preserved with CR→LF normalization
 *   - finite primitives / plain objects / arrays converted deterministically
 *   - nested BSON host types and non-finite numbers abort (recursive check)
 *   - result must fit write limits (≤50 entries, value ≤2000)
 *   - keys including `__proto__` round-trip via null-proto + defineProperty
 *
 * Down: original JSON types cannot be reconstructed from strings alone
 * (lossy conversion), so rollback is intentionally unsupported.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const rows = (await mdb
    .collection("models")
    .find(
      {},
      {
        projection: {
          _id: 1,
          aliasId: 1,
          metadata: 1,
        },
      },
    )
    .toArray()) as unknown as ModelRow[];

  if (rows.length === 0) {
    console.log(
      "[migration:normalize-model-metadata] no models to inspect",
    );
    return;
  }

  type UpdateOneOp = {
    updateOne: {
      filter: { _id: ObjectId };
      update: { $set: { metadata: Record<string, string> } };
    };
  };

  const ops: UpdateOneOp[] = [];
  let documentsTouched = 0;
  let valuesConverted = 0;
  let missingSetToEmpty = 0;

  for (const row of rows) {
    const modelId = `${row._id.toHexString()}${row.aliasId ? ` (${row.aliasId})` : ""}`;
    const hadMissing = row.metadata === undefined;
    const { metadata, convertedValues } = normalizeModelMetadata(
      row.metadata,
      modelId,
    );

    // Skip when the field is already present as an all-string map (no-op).
    // Still write when missing (make {} explicit) or any value was converted.
    if (!hadMissing && convertedValues === 0) {
      continue;
    }

    if (hadMissing) missingSetToEmpty += 1;
    documentsTouched += 1;
    valuesConverted += convertedValues;
    ops.push({
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { metadata } },
      },
    });
  }

  if (ops.length > 0) {
    await mdb.collection("models").bulkWrite(ops, { ordered: true });
  }

  console.log(
    `[migration:normalize-model-metadata] inspected ${rows.length} model(s); updated ${documentsTouched} document(s); converted ${valuesConverted} value(s); set missing→{} on ${missingSetToEmpty}`,
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error(
    "normalize-model-metadata cannot be rolled back: original JSON/BSON types cannot be reconstructed from stringified values",
  );
}
