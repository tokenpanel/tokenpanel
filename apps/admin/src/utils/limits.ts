import { formatCompact, formatMicros } from "./format.ts";

export interface LimitRuleLike {
  dimension: string;
  capValue: number;
  currency?: string | null;
  scope: string;
  scopeTarget?: string | null;
}

function isSpend(dimension: string): boolean {
  return dimension === "spend_units" || dimension === "spend_micros";
}

/** Short printed caption for a rolling-limit needle, e.g. "250K tok", "$120.00", "600 req · gpt-4.1". */
export function limitCaption(r: LimitRuleLike): string {
  const cap = isSpend(r.dimension)
    ? formatMicros(r.capValue, r.currency ?? "USD").replace(/ [A-Z]{3}$/, "")
    : formatCompact(r.capValue);
  const unit = r.dimension === "tokens" ? " tok" : r.dimension === "requests" ? " req" : "";
  const target = r.scope === "model" && r.scopeTarget ? ` · ${r.scopeTarget}` : "";
  return `${cap}${unit}${target}`;
}
