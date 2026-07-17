/**
 * Provider, model, catalog, entry, metadata Effect schemas.
 * Metadata uses write/stored modes.
 */
import { ParseResult, Schema } from "effect";
import {
  MODEL_METADATA_POLICY,
  MODEL_METADATA_RESERVED_KEYS as CONTRACT_RESERVED_KEYS,
  isValidModelMetadataKey,
  normalizeMetadataValueNewlines,
  ModelMetadataWrite,
  ProviderHeadersWrite,
  ProviderHeadersDefaultEmpty,
  ProviderMetadataWrite,
  ProviderMetadataDefaultEmpty,
} from "@tokenpanel/contracts/effect";
import {
  ObjectIdFromSelf,
  ObjectIdFromString,
  DateFromSelf,
  TimestampFields,
  TokenPriceSchedule,
  TokenLimits,
  ModelModalities,
  ModelStatus,
  ModelCapabilities,
  Interleaved,
  CurrencyCode,
  UrlString,
  UnknownRecord,
  UnknownRecordDefaultEmpty,
  exactOptional,
  exactNullish,
  boundedString,
  maxString,
  NonNegativeSafeInt,
  ModelAliasId,
} from "./primitives.ts";

export const MODEL_METADATA_MAX_ENTRIES = MODEL_METADATA_POLICY.maxEntries;
export const MODEL_METADATA_KEY_MAX_LEN = MODEL_METADATA_POLICY.keyMaxLen;
export const MODEL_METADATA_VALUE_MAX_LEN = MODEL_METADATA_POLICY.valueMaxLen;
export const MODEL_METADATA_RESERVED_KEYS = new Set<string>(
  CONTRACT_RESERVED_KEYS,
);

export { isValidModelMetadataKey, normalizeMetadataValueNewlines };

export function isPlainMetadataObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function createStringRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function setStringRecordEntry(
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

export type ParseStringRecordMode = "write" | "stored";

export function parseStringRecord(
  val: unknown,
  opts: { mode: ParseStringRecordMode },
):
  | { ok: true; data: Record<string, string> }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] } {
  if (val === undefined) {
    return { ok: true, data: createStringRecord() };
  }
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: "metadata must be an object of string key/value pairs",
        },
      ],
    };
  }
  if (!isPlainMetadataObject(val)) {
    const kind =
      val instanceof Date
        ? "Date"
        : (val as { constructor?: { name?: string } }).constructor?.name ??
          typeof val;
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `metadata must be a plain object (got ${kind})`,
        },
      ],
    };
  }
  const rawKeys = Reflect.ownKeys(val).filter(
    (k): k is string => typeof k === "string",
  );
  if (Reflect.ownKeys(val).some((k) => typeof k === "symbol")) {
    return {
      ok: false,
      issues: [{ path: [], message: "metadata keys must be strings" }],
    };
  }

  const write = opts.mode === "write";
  if (write && rawKeys.length > MODEL_METADATA_MAX_ENTRIES) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `metadata may have at most ${MODEL_METADATA_MAX_ENTRIES} entries`,
        },
      ],
    };
  }
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  const record = val as Record<string, unknown>;
  const out = createStringRecord();

  for (const rawKey of rawKeys) {
    const value = record[rawKey];
    if (typeof value !== "string") {
      issues.push({
        path: [rawKey],
        message: "metadata values must be strings",
      });
      continue;
    }
    const normalized = normalizeMetadataValueNewlines(value);
    if (write && normalized.length > MODEL_METADATA_VALUE_MAX_LEN) {
      issues.push({
        path: [rawKey],
        message: `metadata value must be at most ${MODEL_METADATA_VALUE_MAX_LEN} characters`,
      });
      continue;
    }
    if (write) {
      const key = rawKey.trim();
      if (!isValidModelMetadataKey(key)) {
        issues.push({
          path: [rawKey],
          message:
            "metadata key must be 1–80 chars after trim, no control characters, no leading $, and not a reserved key (__proto__/prototype/constructor)",
        });
        continue;
      }
      if (seen.has(key)) {
        issues.push({
          path: [rawKey],
          message: `duplicate metadata key after trim: ${key}`,
        });
        continue;
      }
      seen.add(key);
      setStringRecordEntry(out, key, normalized);
    } else {
      setStringRecordEntry(out, rawKey, normalized);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: out };
}

/** Write contract — reuses contracts ModelMetadataWrite. */
export const ModelMetadataInput = ModelMetadataWrite;

/** Stored path: plain object of strings; no entry caps (legacy rehydrate). */
export const ModelMetadataStored: Schema.Schema<
  Record<string, string>,
  unknown
> = Schema.transformOrFail(
  Schema.Unknown,
  // Unknown as output so decode result is not re-assigned through Schema.Record
  // (which would drop own `__proto__` via ordinary object set).
  Schema.Unknown as unknown as Schema.Schema<Record<string, string>>,
  {
    strict: true,
    decode: (val, _opts, ast) => {
      if (val === undefined) {
        return ParseResult.succeed(createStringRecord());
      }
      const parsed = parseStringRecord(val, { mode: "stored" });
      if (!parsed.ok) {
        const first = parsed.issues[0];
        if (first && first.path.length > 0) {
          const path = first.path as [PropertyKey, ...PropertyKey[]];
          return ParseResult.fail(
            new ParseResult.Pointer(
              path,
              val,
              new ParseResult.Type(ast, val, first.message),
            ),
          );
        }
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            val,
            first?.message ?? "invalid metadata",
          ),
        );
      }
      return ParseResult.succeed(parsed.data);
    },
    encode: (out) => ParseResult.succeed(out as unknown),
  },
);

export type ModelMetadata = Record<string, string>;

export const ProviderSdkType = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(80),
  Schema.pattern(
    /^(openai-compatible|anthropic-compatible|plugin:[a-z0-9_-]+)$/,
  ),
);

/**
 * Per-provider HTTP timeout override (milliseconds).
 * 0 = no app-level timeout for this provider.
 * Max 1 hour (matches PROVIDER_HTTP_TIMEOUT_MS env cap).
 * null / omitted on the doc = inherit process global default.
 */
export const ProviderHttpTimeoutMs = NonNegativeSafeInt.pipe(
  Schema.lessThanOrEqualTo(3_600_000),
);

export const ProviderDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  name: boundedString(1, 120),
  sdkType: ProviderSdkType,
  apiKeyEncrypted: Schema.String.pipe(Schema.minLength(1)),
  baseUrl: UrlString,
  providerOrg: exactNullish(maxString(120)),
  headers: ProviderHeadersDefaultEmpty,
  active: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  /**
   * Optional HTTP timeout override (ms). null/absent → global
   * PROVIDER_HTTP_TIMEOUT_MS. 0 → disable app timeout for this provider.
   */
  httpTimeoutMs: exactNullish(ProviderHttpTimeoutMs),
  metadata: ProviderMetadataDefaultEmpty,
  ...TimestampFields,
});

export const ProviderCreateInput = Schema.Struct({
  name: boundedString(1, 120),
  sdkType: ProviderSdkType,
  apiKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(400)),
  baseUrl: UrlString,
  providerOrg: exactOptional(maxString(120)),
  headers: exactOptional(ProviderHeadersWrite),
  /** Omit to inherit global default; 0 disables; positive overrides. */
  httpTimeoutMs: exactOptional(ProviderHttpTimeoutMs),
  metadata: exactOptional(ProviderMetadataWrite),
});

export const ProviderUpdateInput = Schema.Struct({
  name: exactOptional(boundedString(1, 120)),
  sdkType: exactOptional(ProviderSdkType),
  apiKey: exactOptional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(400)),
  ),
  baseUrl: exactOptional(UrlString),
  providerOrg: exactNullish(maxString(120)),
  headers: exactOptional(ProviderHeadersWrite),
  active: exactOptional(Schema.Boolean),
  /** null clears override (inherit global); 0 disables; positive overrides. */
  httpTimeoutMs: exactNullish(ProviderHttpTimeoutMs),
  metadata: exactOptional(ProviderMetadataWrite),
});

export type ProviderDoc = Schema.Schema.Type<typeof ProviderDoc>;
export type ProviderCreateInput = Schema.Schema.Type<typeof ProviderCreateInput>;
export type ProviderUpdateInput = Schema.Schema.Type<typeof ProviderUpdateInput>;

export const ModelCatalogDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  providerId: ObjectIdFromSelf,
  upstreamModelId: boundedString(1, 160),
  displayName: boundedString(1, 160),
  reasoning: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  toolCall: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  interleaved: exactNullish(Interleaved),
  limits: TokenLimits,
  modalities: ModelModalities,
  status: exactOptional(ModelStatus),
  cost: exactOptional(TokenPriceSchedule),
  raw: UnknownRecordDefaultEmpty,
  discoveredAt: DateFromSelf,
  ...TimestampFields,
});

export type ModelCatalogDoc = Schema.Schema.Type<typeof ModelCatalogDoc>;

/** Catalog upsert write (discover path). */
export const ModelCatalogCreateInput = Schema.Struct({
  organizationId: ObjectIdFromSelf,
  providerId: ObjectIdFromSelf,
  upstreamModelId: boundedString(1, 160),
  displayName: boundedString(1, 160),
  reasoning: exactOptional(Schema.Boolean),
  toolCall: exactOptional(Schema.Boolean),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: exactOptional(Schema.Boolean),
  interleaved: exactNullish(Interleaved),
  limits: TokenLimits,
  modalities: ModelModalities,
  status: exactOptional(ModelStatus),
  cost: exactOptional(TokenPriceSchedule),
  raw: exactOptional(UnknownRecord),
  discoveredAt: exactOptional(DateFromSelf),
});

export type ModelCatalogCreateInput = Schema.Schema.Type<
  typeof ModelCatalogCreateInput
>;

export const ModelEntryDoc = Schema.Struct({
  id: boundedString(1, 40),
  providerId: ObjectIdFromSelf,
  upstreamModelId: boundedString(1, 160),
  cost: exactOptional(TokenPriceSchedule),
  price: exactOptional(TokenPriceSchedule),
  priority: Schema.optionalWith(NonNegativeSafeInt, { default: () => 0 }),
  active: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});

export const ModelEntryInput = Schema.Struct({
  id: exactOptional(boundedString(1, 40)),
  providerId: ObjectIdFromString,
  upstreamModelId: boundedString(1, 160),
  cost: exactOptional(TokenPriceSchedule),
  price: exactOptional(TokenPriceSchedule),
  priority: exactOptional(NonNegativeSafeInt),
  active: exactOptional(Schema.Boolean),
});

export const ModelDoc = Schema.Struct({
  _id: ObjectIdFromSelf,
  organizationId: ObjectIdFromSelf,
  aliasId: ModelAliasId,
  displayName: boundedString(1, 160),
  description: exactNullish(maxString(2000)),
  entries: Schema.Array(ModelEntryDoc).pipe(Schema.minItems(1)),
  reasoning: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  toolCall: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  interleaved: exactNullish(Interleaved),
  limits: TokenLimits,
  modalities: ModelModalities,
  status: exactOptional(ModelStatus),
  price: TokenPriceSchedule,
  marginBps: Schema.optionalWith(NonNegativeSafeInt, { default: () => 0 }),
  currency: CurrencyCode,
  active: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  metadata: ModelMetadataStored,
  ...TimestampFields,
});

export const ModelCreateInput = Schema.Struct({
  aliasId: ModelAliasId,
  displayName: boundedString(1, 160),
  description: exactOptional(maxString(2000)),
  entries: Schema.Array(ModelEntryInput).pipe(Schema.minItems(1)),
  reasoning: exactOptional(Schema.Boolean),
  toolCall: exactOptional(Schema.Boolean),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: exactOptional(Schema.Boolean),
  limits: TokenLimits,
  modalities: ModelModalities,
  status: exactOptional(ModelStatus),
  price: TokenPriceSchedule,
  marginBps: exactOptional(NonNegativeSafeInt),
  currency: CurrencyCode,
  metadata: exactOptional(ModelMetadataInput),
});

export const ModelUpdateInput = Schema.Struct({
  aliasId: exactOptional(ModelAliasId),
  displayName: exactOptional(boundedString(1, 160)),
  description: exactNullish(maxString(2000)),
  entries: exactOptional(
    Schema.Array(ModelEntryInput).pipe(Schema.minItems(1)),
  ),
  reasoning: exactOptional(Schema.Boolean),
  toolCall: exactOptional(Schema.Boolean),
  structuredOutput: exactOptional(Schema.Boolean),
  temperature: exactOptional(Schema.Boolean),
  attachment: exactOptional(Schema.Boolean),
  limits: exactOptional(TokenLimits),
  modalities: exactOptional(ModelModalities),
  status: exactOptional(ModelStatus),
  price: exactOptional(TokenPriceSchedule),
  marginBps: exactOptional(NonNegativeSafeInt),
  currency: exactOptional(CurrencyCode),
  active: exactOptional(Schema.Boolean),
  metadata: exactOptional(ModelMetadataInput),
});

export const FallbackReorderInput = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      id: boundedString(1, 40),
      priority: NonNegativeSafeInt,
    }),
  ),
});

export type ModelDoc = Schema.Schema.Type<typeof ModelDoc>;
export type ModelCreateInput = Schema.Schema.Type<typeof ModelCreateInput>;
export type ModelUpdateInput = Schema.Schema.Type<typeof ModelUpdateInput>;
export type ModelEntryDoc = Schema.Schema.Type<typeof ModelEntryDoc>;
export type ModelEntryInput = Schema.Schema.Type<typeof ModelEntryInput>;
export type FallbackReorderInput = Schema.Schema.Type<
  typeof FallbackReorderInput
>;

// silence unused ModelCapabilities export reference for tree-shaking clarity
void ModelCapabilities;
