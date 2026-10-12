import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Secondary text shown to the right in the menu (e.g. an alias). */
  hint?: string;
}

interface MultiSelectProps {
  id?: string | undefined;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Shown when nothing is selected (describe what "none" means, e.g. "All models"). */
  placeholder: string;
  /** Menu heading. */
  label?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  "aria-describedby"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
}

/**
 * Checkbox dropdown for picking several known values. Selected values render
 * as chips in the trigger; the menu stays open while toggling.
 * Values that are selected but no longer offered (e.g. a deleted model) stay
 * visible so saving never drops them silently.
 */
export function MultiSelect({
  id,
  options,
  value,
  onChange,
  placeholder,
  label,
  disabled,
  className,
  ...aria
}: MultiSelectProps): React.ReactElement {
  const selected = new Set(value);
  const known = new Set(options.map((o) => o.value));
  const all: MultiSelectOption[] = [
    ...options,
    ...value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v, hint: "not found" })),
  ];
  const labelFor = (v: string) => all.find((o) => o.value === v)?.label ?? v;

  function toggle(v: string, on: boolean) {
    const next = on ? [...value.filter((x) => x !== v), v] : value.filter((x) => x !== v);
    // Keep the option order stable rather than click order.
    onChange(all.map((o) => o.value).filter((x) => next.includes(x)));
  }

  return (
    <DropdownMenu modal={false}>
      <div
        className={cn(
          "relative flex min-h-9 w-full items-center rounded-md border border-input bg-card shadow-[0_1px_0_oklch(0_0_0/0.04)] transition-[border-color,box-shadow]",
          "hover:border-[color-mix(in_oklch,var(--input)_70%,var(--foreground))]",
          "has-[button[data-state=open]]:border-signal has-[button:focus-visible]:border-signal has-[button:focus-visible]:ring-[3px] has-[button:focus-visible]:ring-ring",
          aria["aria-invalid"] && "border-destructive",
          disabled && "pointer-events-none opacity-50",
          className,
        )}
      >
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            id={id}
            type="button"
            aria-describedby={aria["aria-describedby"]}
            aria-invalid={aria["aria-invalid"]}
            className="flex min-h-9 flex-1 flex-wrap items-center gap-1 py-1 pl-2 pr-9 text-left text-sm outline-none"
          >
            {value.length === 0 ? (
              <span className="px-1 text-muted-foreground">{placeholder}</span>
            ) : (
              value.map((v) => (
                <span
                  key={v}
                  className="inline-flex h-6 items-center rounded-[4px] bg-secondary px-2 text-[13px] text-secondary-foreground"
                >
                  {labelFor(v)}
                </span>
              ))
            )}
          </button>
        </DropdownMenuTrigger>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      </div>
      <DropdownMenuContent
        align="start"
        className="max-h-80 w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 overflow-y-auto"
      >
        {label ? <DropdownMenuLabel>{label}</DropdownMenuLabel> : null}
        {all.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Nothing to choose from yet.</div>
        ) : (
          all.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={selected.has(o.value)}
              onCheckedChange={(c) => toggle(o.value, c === true)}
              onSelect={(e) => e.preventDefault()}
              className="gap-3"
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{o.hint}</span> : null}
            </DropdownMenuCheckboxItem>
          ))
        )}
        {all.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <div className="grid grid-cols-2 gap-1">
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  onChange(all.map((o) => o.value));
                }}
                className="justify-center text-[13px]"
              >
                Select all
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  onChange([]);
                }}
                disabled={value.length === 0}
                className="justify-center text-[13px]"
              >
                Clear
              </DropdownMenuItem>
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
