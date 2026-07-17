/**
 * Pure model form helpers + types (extracted from ModelsPage for domain split).
 * UI components remain in ModelsPage.tsx / co-located modules.
 */
import type { FetchedModel } from "../../api/catalog.ts";
import {
  MODEL_MODALITIES,
  MODEL_METADATA_POLICY,
  isValidModelMetadataKey,
  normalizeMetadataValueNewlines,
  type ModelModality,
  type ModelStatus,
} from "@tokenpanel/contracts";

const MODALITIES = MODEL_MODALITIES;
type Modality = ModelModality;
type Status = ModelStatus;

export interface TokenPriceSchedule {
  inputUnitsPerMillion: number;
  outputUnitsPerMillion: number;
  reasoningUnitsPerMillion?: number;
  cacheReadUnitsPerMillion?: number;
  cacheWriteUnitsPerMillion?: number;
  inputAudioUnitsPerMillion?: number;
  outputAudioUnitsPerMillion?: number;
}

export interface ModelEntry {
  id: string;
  providerId: string;
  upstreamModelId: string;
  cost?: TokenPriceSchedule;
  price?: TokenPriceSchedule;
  priority: number;
  active: boolean;
}

export interface ModelLimits {
  context: number;
  input?: number;
  output?: number;
}

export interface ModelModalities {
  input: Modality[];
  output: Modality[];
}

export interface Model {
  _id: string;
  organizationId: string;
  aliasId: string;
  displayName: string;
  description?: string | null;
  entries: ModelEntry[];
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput?: boolean;
  temperature?: boolean;
  attachment: boolean;
  limits: ModelLimits;
  modalities: ModelModalities;
  status?: Status;
  price: TokenPriceSchedule;
  marginBps: number;
  currency: string;
  active: boolean;
  /** String key/value configuration; may be legacy non-string until post-migration. */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  _id: string;
  organizationId: string;
  name: string;
  sdkType: string;
  baseUrl: string;
  active: boolean;
  hasApiKey: boolean;
}

/** Client-only metadata editor row (stable id for React keys / incomplete rows). */
export interface MetadataRow {
  id: string;
  key: string;
  value: string;
}

const METADATA_MAX_ENTRIES = MODEL_METADATA_POLICY.maxEntries;
const METADATA_VALUE_MAX_LEN = MODEL_METADATA_POLICY.valueMaxLen;

type StatusFilter = Status | "none";

let metadataRowSeq = 0;
export function newMetadataRowId(): string {
  metadataRowSeq += 1;
  return `meta-${metadataRowSeq}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Deterministic string coercion for defensive rehydrate during deploy window. */
export function coerceMetadataValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (Array.isArray(v)) {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  if (v !== null && typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/**
 * Map saved/fetched metadata object → editor rows.
 * Missing / undefined → empty ok rows.
 * Malformed (null, array, non-object) → corrupt flag so save will not
 * accidentally replace the stored map with {}.
 */
export function metadataToRows(
  metadata: Record<string, unknown> | null | undefined,
): { rows: MetadataRow[]; corrupt: boolean; corruptReason?: string } {
  if (metadata === undefined) {
    return { rows: [], corrupt: false };
  }
  if (metadata === null) {
    return {
      rows: [],
      corrupt: true,
      corruptReason: "Stored metadata is null (expected an object).",
    };
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      rows: [],
      corrupt: true,
      corruptReason: Array.isArray(metadata)
        ? "Stored metadata is an array (expected an object)."
        : `Stored metadata has unexpected type ${typeof metadata}.`,
    };
  }
  const rows = Object.entries(metadata).map(([key, value]) => ({
    id: newMetadataRowId(),
    key,
    value: coerceMetadataValue(value),
  }));
  return { rows, corrupt: false };
}

/** Admin alias for the shared write-contract key validator. */
export function isValidMetadataKey(key: string): boolean {
  return isValidModelMetadataKey(key);
}

export interface MetadataFieldErrors {
  key?: string;
  value?: string;
}

/** Per-field validation messages for a metadata row (for inline a11y errors). */
export function metadataRowFieldErrors(
  row: MetadataRow,
  allRows: MetadataRow[],
): MetadataFieldErrors {
  const keyTrimmed = row.key.trim();
  const blankKey = keyTrimmed === "";
  const blankValue = row.value === "";
  if (blankKey && blankValue) return {};

  const errors: MetadataFieldErrors = {};
  if (blankKey) {
    errors.key = "Name is required when a value is set.";
  } else if (/[\r\n]/.test(keyTrimmed)) {
    errors.key = "Name cannot contain line breaks.";
  } else if (!isValidMetadataKey(keyTrimmed)) {
    errors.key =
      "Name must be 1–80 characters, no leading $, and not a reserved name.";
  } else {
    const dup = allRows.some(
      (r) => r.id !== row.id && r.key.trim() === keyTrimmed && keyTrimmed !== "",
    );
    if (dup) errors.key = `Duplicate name: ${keyTrimmed}`;
  }
  // Length is checked after CR/CRLF → LF so UI matches the API write contract
  // (e.g. "\r\n".repeat(1001) is 1001 chars after normalize, not 2002).
  const normalizedLen = normalizeMetadataValueNewlines(row.value).length;
  if (normalizedLen > METADATA_VALUE_MAX_LEN) {
    errors.value = `Value must be at most ${METADATA_VALUE_MAX_LEN} characters.`;
  }
  return errors;
}

/** Re-export shared newline normalization for page unit tests. */
export { normalizeMetadataValueNewlines };

/**
 * Convert UI rows to a metadata object for create/update.
 * Fully blank rows (empty key and value) are omitted; any row with content
 * requires a name. Keys are trimmed; values use LF-normalized newlines.
 */
export function rowsToMetadata(
  rows: MetadataRow[],
): { ok: true; metadata: Record<string, string> } | { ok: false; error: string } {
  const metadata: Record<string, string> = {};
  const seen = new Set<string>();

  for (const row of rows) {
    const fieldErrs = metadataRowFieldErrors(row, rows);
    if (fieldErrs.key) return { ok: false, error: fieldErrs.key };
    if (fieldErrs.value) return { ok: false, error: fieldErrs.value };

    const keyTrimmed = row.key.trim();
    const blankKey = keyTrimmed === "";
    const blankValue = row.value === "";
    if (blankKey && blankValue) continue;

    seen.add(keyTrimmed);
    // Match browser textarea + API write contract (CR/CRLF → LF).
    metadata[keyTrimmed] = normalizeMetadataValueNewlines(row.value);
  }

  if (Object.keys(metadata).length > METADATA_MAX_ENTRIES) {
    return {
      ok: false,
      error: `At most ${METADATA_MAX_ENTRIES} metadata pairs allowed.`,
    };
  }

  return { ok: true, metadata };
}

export function parseModalities(raw: string): Modality[] {
  const seen = new Set<Modality>();
  for (const part of raw.split(",")) {
    const t = part.trim().toLowerCase();
    if ((MODALITIES as readonly string[]).includes(t)) {
      seen.add(t as Modality);
    }
  }
  return Array.from(seen);
}

export function modalitiesToText(list: Modality[]): string {
  return list.join(", ");
}

export function toInt(v: string): number | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

export function toPositiveInt(v: string): number | undefined {
  const n = toInt(v);
  if (n === undefined) return undefined;
  return n > 0 ? n : undefined;
}

export function toNonNegInt(v: string): number | undefined {
  const n = toInt(v);
  if (n === undefined) return undefined;
  return n >= 0 ? n : undefined;
}

export interface FormState {
  aliasId: string;
  displayName: string;
  description: string;
  reasoning: boolean;
  toolCall: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  attachment: boolean;
  contextLimit: string;
  inputLimit: string;
  outputLimit: string;
  inputModalities: string;
  outputModalities: string;
  status: StatusFilter;
  inputUnits: string;
  outputUnits: string;
  currency: string;
  marginBps: string;
  firstProviderId: string;
  firstUpstreamModelId: string;
  /** Metadata editor rows (client-only ids; may be incomplete before save). */
  metadataRows: MetadataRow[];
  /**
   * True when loaded metadata was malformed (null/array/non-object). While set,
   * save omits `metadata` so an unrelated edit cannot overwrite stored data with {}.
   * Cleared when the user edits metadata (add/clear/change rows).
   */
  metadataSourceMalformed: boolean;
  metadataCorruptReason: string | null;
}

export function emptyForm(): FormState {
  return {
    aliasId: "",
    displayName: "",
    description: "",
    reasoning: false,
    toolCall: false,
    structuredOutput: false,
    temperature: false,
    attachment: false,
    contextLimit: "",
    inputLimit: "",
    outputLimit: "",
    inputModalities: "text",
    outputModalities: "text",
    status: "none",
    inputUnits: "0",
    outputUnits: "0",
    currency: "USD",
    marginBps: "0",
    firstProviderId: "",
    firstUpstreamModelId: "",
    metadataRows: [],
    metadataSourceMalformed: false,
    metadataCorruptReason: null,
  };
}

export function formFromModel(m: Model): FormState {
  const mapped = metadataToRows(m.metadata);
  return {
    aliasId: m.aliasId,
    displayName: m.displayName,
    description: m.description ?? "",
    reasoning: m.reasoning,
    toolCall: m.toolCall,
    structuredOutput: m.structuredOutput ?? false,
    temperature: m.temperature ?? false,
    attachment: m.attachment,
    contextLimit: String(m.limits.context),
    inputLimit: m.limits.input !== undefined ? String(m.limits.input) : "",
    outputLimit: m.limits.output !== undefined ? String(m.limits.output) : "",
    inputModalities: modalitiesToText(m.modalities.input),
    outputModalities: modalitiesToText(m.modalities.output),
    status: m.status ?? "none",
    inputUnits: String(m.price.inputUnitsPerMillion),
    outputUnits: String(m.price.outputUnitsPerMillion),
    currency: m.currency,
    marginBps: String(m.marginBps),
    firstProviderId: "",
    firstUpstreamModelId: "",
    metadataRows: mapped.rows,
    metadataSourceMalformed: mapped.corrupt,
    metadataCorruptReason: mapped.corruptReason ?? null,
  };
}

export function slugifyModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Map a fetched catalog model onto the Add Model form state. Preserves fields
 * the catalog doesn't know about (currency, marginBps, firstProviderId,
 * metadataRows) so the admin's existing choices aren't clobbered. The fetched
 * upstreamModelId is dropped into the primary-entry upstream field as a
 * convenience; the admin still picks which of their configured providers
 * serves it.
 */
export function formFromFetched(m: FetchedModel, base: FormState): FormState {
  return {
    ...base,
    aliasId: slugifyModelId(m.upstreamModelId),
    displayName: m.displayName,
    reasoning: m.reasoning ?? false,
    toolCall: m.toolCall ?? false,
    structuredOutput: m.structuredOutput ?? false,
    temperature: m.temperature ?? false,
    attachment: m.attachment ?? false,
    contextLimit: m.limits.context > 0 ? String(m.limits.context) : base.contextLimit,
    inputLimit: m.limits.input !== undefined && m.limits.input > 0 ? String(m.limits.input) : base.inputLimit,
    outputLimit: m.limits.output !== undefined && m.limits.output > 0 ? String(m.limits.output) : base.outputLimit,
    inputModalities: m.modalities.input.length > 0 ? modalitiesToText(m.modalities.input as Modality[]) : base.inputModalities,
    outputModalities: m.modalities.output.length > 0 ? modalitiesToText(m.modalities.output as Modality[]) : base.outputModalities,
    status: m.status ?? "none",
    inputUnits: m.cost ? String(m.cost.inputUnitsPerMillion) : base.inputUnits,
    outputUnits: m.cost ? String(m.cost.outputUnitsPerMillion) : base.outputUnits,
    firstUpstreamModelId: m.upstreamModelId,
    // metadataRows preserved via ...base
  };
}

export function buildModelPayload(f: FormState, isCreate: boolean):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const aliasId = f.aliasId.trim();
  if (!aliasId) return { ok: false, error: "Alias ID required." };
  if (!/^[a-z0-9_-]+$/.test(aliasId))
    return { ok: false, error: "Alias ID must be lowercase slug (a-z0-9_-)." };

  const displayName = f.displayName.trim();
  if (!displayName) return { ok: false, error: "Display name required." };

  const context = toPositiveInt(f.contextLimit);
  if (context === undefined)
    return { ok: false, error: "Context limit must be a positive integer." };

  const inputUnits = toNonNegInt(f.inputUnits);
  const outputUnits = toNonNegInt(f.outputUnits);
  if (inputUnits === undefined || outputUnits === undefined)
    return { ok: false, error: "Price must be non-negative integers." };

  const marginBps = toNonNegInt(f.marginBps);
  if (marginBps === undefined)
    return { ok: false, error: "Margin (bps) must be a non-negative integer." };

  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    return { ok: false, error: "Currency must be a 3-letter code (e.g. USD)." };

  const limits: Record<string, unknown> = { context };
  const inputLimit = toPositiveInt(f.inputLimit);
  if (inputLimit !== undefined) limits.input = inputLimit;
  const outputLimit = toPositiveInt(f.outputLimit);
  if (outputLimit !== undefined) limits.output = outputLimit;

  const inputModalities = parseModalities(f.inputModalities);
  const outputModalities = parseModalities(f.outputModalities);

  const status = f.status === "none" ? undefined : f.status;

  const price: TokenPriceSchedule = {
    inputUnitsPerMillion: inputUnits,
    outputUnitsPerMillion: outputUnits,
  };

  const payload: Record<string, unknown> = {
    aliasId,
    displayName,
    description: f.description.trim() || undefined,
    reasoning: f.reasoning,
    toolCall: f.toolCall,
    structuredOutput: f.structuredOutput || undefined,
    temperature: f.temperature || undefined,
    attachment: f.attachment,
    limits,
    modalities: { input: inputModalities, output: outputModalities },
    status,
    price,
    marginBps,
    currency,
  };

  // Malformed stored metadata: omit so PATCH preserves the server map until
  // the user explicitly edits/clears metadata (clears metadataSourceMalformed).
  if (f.metadataSourceMalformed) {
    // create still needs a valid default; cannot create with corrupt source.
    if (isCreate) {
      return {
        ok: false,
        error:
          f.metadataCorruptReason ??
          "Metadata is malformed and must be cleared before create.",
      };
    }
  } else {
    const meta = rowsToMetadata(f.metadataRows);
    if (!meta.ok) return { ok: false, error: meta.error };
    // Always send metadata so removing the final row persists as {}.
    payload.metadata = meta.metadata;
  }

  if (isCreate) {
    const providerId = f.firstProviderId.trim();
    const upstreamModelId = f.firstUpstreamModelId.trim();
    if (!providerId) return { ok: false, error: "Select a provider for the primary entry." };
    if (!upstreamModelId)
      return { ok: false, error: "Enter an upstream model id for the primary entry." };
    payload.entries = [
      {
        providerId,
        upstreamModelId,
        priority: 0,
        active: true,
      },
    ];
  }

  return { ok: true, payload };
}

