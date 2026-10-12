import * as React from "react";
import { parseMajorToMicros } from "@tokenpanel/contracts";
import { formatMicros } from "@/utils/format";

interface UnitsPreviewProps {
  /** Raw decimal major-unit string from the input (may be empty or invalid). */
  value: string;
  /** ISO 4217 currency code (e.g. "USD", "JPY"). */
  currency: string;
  /** Optional suffix appended after the formatted money (e.g. "/ 1M tokens"). */
  suffix?: string;
  /** Allow a leading minus (signed money such as balance adjustments). */
  allowNegative?: boolean;
}

/**
 * Live preview of a decimal major-unit input as formatted money. The input is
 * parsed to integer micros (exact, no float) and rendered with adaptive
 * precision. Renders nothing when the value is empty, invalid, or zero.
 */
function UnitsPreview({ value, currency, suffix, allowNegative }: UnitsPreviewProps): React.ReactElement | null {
  if (!value.trim()) return null;
  let micros: number;
  try {
    micros = parseMajorToMicros(value, { allowNegative });
  } catch {
    return null;
  }
  if (micros === 0) return null;
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      ≈ {formatMicros(micros, currency)}{suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export { UnitsPreview };
export type { UnitsPreviewProps };
