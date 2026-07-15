/**
 * ISO 4217 minor-unit exponents for currencies we format.
 * amountMinor is always integer minor units (JPY yen=1, USD cent=1, KWD fils=1).
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

/**
 * Format minor units as display money. Always includes the ISO currency code so
 * dollar-symbol currencies (USD/AUD/CAD/…) are never ambiguous in multi-currency UIs.
 */
export function formatMoney(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const code = currency.toUpperCase();
  const exp = currencyExponent(code);
  const divisor = 10 ** exp;
  const major = Math.floor(abs / divisor);
  const frac = abs % divisor;
  const fracStr =
    exp === 0 ? "" : `.${String(frac).padStart(exp, "0")}`;

  switch (code) {
    case "USD":
    case "AUD":
    case "CAD":
    case "NZD":
    case "HKD":
    case "SGD":
      return `${sign}$${major}${fracStr} ${code}`;
    case "EUR":
      return `${sign}\u20ac${major}${fracStr} ${code}`;
    case "GBP":
      return `${sign}\u00a3${major}${fracStr} ${code}`;
    case "JPY":
      return `${sign}\u00a5${major} ${code}`;
    case "INR":
      return `${sign}\u20b9${major}${fracStr} ${code}`;
    case "KRW":
      return `${sign}\u20a9${major} ${code}`;
    case "KWD":
    case "BHD":
    case "OMR":
      return `${sign}${major}${fracStr} ${code}`;
    default:
      return `${sign}${major}${fracStr} ${code}`;
  }
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
