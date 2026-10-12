/** ISO 4217 currency lists and names for pickers (browser Intl, no network). */

/** Shown first; the rest of ISO 4217 follows. */
export const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "INR", "CAD", "AUD", "SGD", "CHF", "CNY", "BRL", "AED"] as const;

let cachedAll: string[] | null = null;

/** Every ISO 4217 code the browser knows (Intl), falling back to the common set. */
export function allCurrencyCodes(): string[] {
  if (cachedAll) return cachedAll;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const list = intl.supportedValuesOf?.("currency");
    cachedAll = list && list.length > 0 ? [...list].sort() : [...COMMON_CURRENCIES];
  } catch {
    cachedAll = [...COMMON_CURRENCIES];
  }
  return cachedAll;
}

const nameCache = new Map<string, string>();

export function currencyName(code: string): string {
  const hit = nameCache.get(code);
  if (hit !== undefined) return hit;
  let name = "";
  try {
    name = new Intl.DisplayNames(undefined, { type: "currency" }).of(code) ?? "";
  } catch {
    name = "";
  }
  if (name === code) name = "";
  nameCache.set(code, name);
  return name;
}
