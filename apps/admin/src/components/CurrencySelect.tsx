import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { COMMON_CURRENCIES as COMMON, allCurrencyCodes, currencyName } from "../utils/currency.ts";

interface CurrencySelectProps {
  id?: string | undefined;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  /** Extra codes to surface at the top (e.g. the organization default). */
  suggest?: readonly string[] | undefined;
  "aria-label"?: string | undefined;
}

/**
 * ISO 4217 currency picker. Common codes first, then every code the browser
 * knows; type the first letters to jump (Radix typeahead). The current value is
 * always listed, even if the browser does not know it.
 */
export function CurrencySelect({
  id,
  value,
  onChange,
  disabled,
  className,
  suggest = [],
  ...rest
}: CurrencySelectProps): React.ReactElement {
  const current = value.trim().toUpperCase();
  const top = Array.from(new Set([...suggest.map((c) => c.toUpperCase()), ...(current ? [current] : []), ...COMMON])).filter(
    (c) => /^[A-Z]{3}$/.test(c),
  );
  const topSet = new Set(top);
  const rest_ = allCurrencyCodes().filter((c) => !topSet.has(c));
  const item = (code: string) => {
    const name = currencyName(code);
    return (
      <SelectItem key={code} value={code}>
        <span className="font-medium tabular-nums">{code}</span>
        {name ? <span className="text-muted-foreground"> · {name}</span> : null}
      </SelectItem>
    );
  };
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled ?? false}>
      <SelectTrigger id={id} className={className} aria-label={rest["aria-label"]}>
        <SelectValue placeholder="Currency">{current || undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        <SelectGroup>
          <SelectLabel>Common</SelectLabel>
          {top.map(item)}
        </SelectGroup>
        {rest_.length > 0 ? (
          <>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>All currencies</SelectLabel>
              {rest_.map(item)}
            </SelectGroup>
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}
