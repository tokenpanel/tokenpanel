export function formatMoney(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  const minorStr = minor < 10 ? `0${minor}` : String(minor);
  const code = currency.toUpperCase();
  switch (code) {
    case "USD":
    case "AUD":
    case "CAD":
    case "NZD":
    case "HKD":
    case "SGD":
      return `${sign}$${major}.${minorStr}`;
    case "EUR":
      return `${sign}\u20ac${major}.${minorStr}`;
    case "GBP":
      return `${sign}\u00a3${major}.${minorStr}`;
    case "JPY":
      return `${sign}\u00a5${major}`;
    case "INR":
      return `${sign}\u20b9${major}.${minorStr}`;
    default:
      return `${sign}${major}.${minorStr} ${code}`;
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