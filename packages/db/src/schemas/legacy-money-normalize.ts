/**
 * In-memory normalize: legacy *Minor money keys → *Units before schema decode.
 *
 * Used at Mongo read boundaries during the rename deploy window (and forever
 * as a no-op once post/ has dropped Minor keys). Prefer existing Units when
 * both are present.
 *
 * Pure / side-effect free — safe to run on every document leaving Mongo.
 */

const SCHEDULE_LEAVES = [
  ["inputUnitsPerMillion", "inputMinorPerMillion"],
  ["outputUnitsPerMillion", "outputMinorPerMillion"],
  ["reasoningUnitsPerMillion", "reasoningMinorPerMillion"],
  ["cacheReadUnitsPerMillion", "cacheReadMinorPerMillion"],
  ["cacheWriteUnitsPerMillion", "cacheWriteMinorPerMillion"],
  ["inputAudioUnitsPerMillion", "inputAudioMinorPerMillion"],
  ["outputAudioUnitsPerMillion", "outputAudioMinorPerMillion"],
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function promote(
  obj: Record<string, unknown>,
  unitsKey: string,
  minorKey: string,
  opts?: { preferMinor?: boolean },
): void {
  const units = obj[unitsKey];
  const minor = obj[minorKey];
  if (opts?.preferMinor) {
    // Balance hot path: old writers only update Minor during pre→swap.
    if (minor !== undefined) obj[unitsKey] = minor;
  } else if (units === undefined && minor !== undefined) {
    obj[unitsKey] = minor;
  }
  // Drop legacy key so schemas that forbid unknown keys (if any) stay clean.
  if (minorKey in obj) {
    delete obj[minorKey];
  }
}

function normalizeSchedule(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  for (const [u, m] of SCHEDULE_LEAVES) {
    promote(o, u, m);
  }
  return o;
}

function normalizeMoney(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  promote(o, "amountUnits", "amountMinor");
  return o;
}

function normalizeBalance(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const o = { ...raw };
  promote(o, "amountUnits", "amountMinor", { preferMinor: true });
  promote(o, "reservedUnits", "reservedMinor", { preferMinor: true });
  return o;
}

function normalizeRateRules(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((rule) => {
    if (!isPlainObject(rule)) return rule;
    const r = { ...rule };
    if (r.dimension === "spend_minor") {
      r.dimension = "spend_units";
    }
    return r;
  });
}

/**
 * Deep-promote known money field renames on a Mongo document (or agg row).
 * Returns a shallow-cloned tree; does not mutate the input.
 */
export function normalizeLegacyMoneyFields(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const doc = { ...value };

  if ("balance" in doc) {
    doc.balance = normalizeBalance(doc.balance);
  }

  promote(doc, "amountUnits", "amountMinor");
  promote(doc, "costUnits", "costMinor");
  promote(doc, "priceUnits", "priceMinor");
  promote(doc, "totalCostUnits", "totalCostMinor");
  promote(doc, "totalPriceUnits", "totalPriceMinor");
  promote(doc, "totalUnits", "totalMinor");

  if ("price" in doc) {
    // Plan money { amount, currency } OR token schedule — both handled.
    const p = doc.price;
    if (isPlainObject(p) && ("currency" in p || "amountMinor" in p || "amountUnits" in p)) {
      doc.price = normalizeMoney(p);
    } else {
      doc.price = normalizeSchedule(p);
    }
  }
  if ("cost" in doc) {
    doc.cost = normalizeSchedule(doc.cost);
  }
  if ("includedCredit" in doc) {
    doc.includedCredit = normalizeMoney(doc.includedCredit);
  }
  if ("startingBalance" in doc) {
    doc.startingBalance = normalizeMoney(doc.startingBalance);
  }

  if (Array.isArray(doc.entries)) {
    doc.entries = doc.entries.map((entry) => {
      if (!isPlainObject(entry)) return entry;
      const e = { ...entry };
      if ("price" in e) e.price = normalizeSchedule(e.price);
      if ("cost" in e) e.cost = normalizeSchedule(e.cost);
      return e;
    });
  }

  if ("rateLimits" in doc) {
    doc.rateLimits = normalizeRateRules(doc.rateLimits);
  }
  if ("rules" in doc) {
    doc.rules = normalizeRateRules(doc.rules);
  }
  if (doc.dimension === "spend_minor") {
    doc.dimension = "spend_units";
  }

  // Settlement outbox context blob
  if (isPlainObject(doc.context)) {
    const ctx = { ...doc.context };
    promote(ctx, "priceUnits", "priceMinor");
    promote(ctx, "costUnits", "costMinor");
    promote(ctx, "reservedUnits", "reservedMinor");
    promote(ctx, "priceUnitsOverride", "priceMinorOverride");
    if ("priceSchedule" in ctx) {
      ctx.priceSchedule = normalizeSchedule(ctx.priceSchedule);
    }
    if ("costSchedule" in ctx) {
      ctx.costSchedule = normalizeSchedule(ctx.costSchedule);
    }
    doc.context = ctx;
  }

  return doc;
}
