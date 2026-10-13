import { formatMicrosToMajor } from "@tokenpanel/contracts";

/**
 * ISO 4217 decimal exponents for display/scale.
 * amountUnits is always an integer: 1 unit = 10^(-exp) of the major unit
 * (USD: $0.01, JPY: ¥1, KWD: 0.001 KWD).
 *
 * Sources: ISO 4217 + common payment-processor tables (Stripe zero-decimal list).
 * Unknown codes default to 2 (ISO majority) — not a signal of validity.
 */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "UYI",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

const FOUR_DECIMAL = new Set([
  "CLF", // Unidad de Fomento
  "UYW", // Unidad Previsional
]);

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  if (FOUR_DECIMAL.has(code)) return 4;
  return 2;
}

/** Currency symbol prefix for display (empty → bare major number). */
function currencySymbol(code: string): string {
  switch (code) {
    case "USD":
    case "AUD":
    case "CAD":
    case "NZD":
    case "HKD":
    case "SGD":
      return "$";
    case "EUR":
      return "\u20ac";
    case "GBP":
      return "\u00a3";
    case "JPY":
      return "\u00a5";
    case "INR":
      return "\u20b9";
    case "KRW":
      return "\u20a9";
    default:
      return "";
  }
}

/** Deterministic thousands grouping for money (1234567 → "1,234,567"). */
function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format integer micros as display money with adaptive precision. Amounts at or
 * above one minor unit render at the currency's standard exponent; sub-minor
 * amounts expand (up to 6 places) so tiny charges never collapse to `$0.00`
 * (e.g. 300 micros → `$0.0003 USD`). Integer-exact via the contracts codec —
 * no float. Always includes the ISO code for multi-currency clarity.
 */
export function formatMicros(amountMicros: number, currency: string): string {
  const sign = amountMicros < 0 ? "-" : "";
  const abs = Math.abs(amountMicros);
  const code = currency.toUpperCase();
  const exp = currencyExponent(code);
  const symbol = currencySymbol(code);
  // Minor unit = 10^(6-exp) micros. At/above it, render at the currency's
  // standard exponent; below it, expand (trimmed) so tiny charges never read
  // as zero (e.g. 300 micros → "$0.0003 USD", not "$0.00 USD").
  const minorMicros = 10 ** (6 - exp);
  if (abs !== 0 && abs < minorMicros) {
    return `${sign}${symbol}${formatMicrosToMajor(abs)} ${code}`;
  }
  const whole = groupThousands(Math.floor(abs / 1_000_000));
  if (exp === 0) return `${sign}${symbol}${whole} ${code}`;
  const fracMicros = abs % 1_000_000;
  const frac = String(fracMicros).padStart(6, "0").slice(0, exp);
  return `${sign}${symbol}${whole}.${frac} ${code}`;
}

/**
 * Money at a fixed number of decimals (2–6), rounded half away from zero in
 * integer micros. For columns where every row must share one precision so
 * amounts align; pair with a title carrying the exact `formatMicros` value.
 */
export function formatMicrosFixed(amountMicros: number, currency: string, decimals: number): string {
  const dp = Math.min(6, Math.max(0, Math.trunc(decimals)));
  const code = currency.toUpperCase();
  const symbol = currencySymbol(code);
  const sign = amountMicros < 0 ? "-" : "";
  const abs = Math.abs(amountMicros);
  const step = 10 ** (6 - dp);
  const rounded = Math.floor((abs + step / 2) / step) * step;
  const whole = groupThousands(Math.floor(rounded / 1_000_000));
  if (dp === 0) return `${sign}${symbol}${whole} ${code}`;
  const frac = String(rounded % 1_000_000).padStart(6, "0").slice(0, dp);
  return `${sign}${symbol}${whole}.${frac} ${code}`;
}

/** Decimals needed so every amount in a column shows at least one significant sub-unit digit (2–4). */
export function columnDecimals(amounts: readonly number[], currency: string): number {
  const base = currencyExponent(currency);
  let dp = base;
  for (const a of amounts) {
    const abs = Math.abs(a);
    if (abs === 0) continue;
    while (dp < 4 && abs < 10 ** (6 - dp)) dp += 1;
  }
  return dp;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "\u2014";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

export function formatCompact(value: number): string {
  return value.toLocaleString(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "\u2014";
  const now = Date.now();
  const diffMs = now - d.getTime();
  const absSec = Math.abs(Math.round(diffMs / 1000));
  if (absSec < 60) return diffMs >= 0 ? "just now" : "soon";
  const absMin = Math.round(absSec / 60);
  if (absMin < 60) return diffMs >= 0 ? `${absMin}m ago` : `in ${absMin}m`;
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return diffMs >= 0 ? `${absHr}h ago` : `in ${absHr}h`;
  const absDay = Math.round(absHr / 24);
  return diffMs >= 0 ? `${absDay}d ago` : `in ${absDay}d`;
}
