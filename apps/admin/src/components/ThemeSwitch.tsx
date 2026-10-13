import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme, type ThemePreference } from "../theme/ThemeContext.tsx";

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: LucideIcon }> = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/**
 * Three-position selector switch (System · Light · Dark), set into the body
 * rail like a mode switch on an appliance.
 */
export function ThemeSwitch({ className }: { className?: string }): React.ReactElement {
  const { preference, setPreference } = useTheme();
  const index = OPTIONS.findIndex((o) => o.value === preference);
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        "relative grid h-8 grid-cols-3 rounded-md bg-sidebar-accent p-[3px] ring-1 ring-inset ring-sidebar-border",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/3)] rounded-[4px] bg-sidebar-foreground/12 shadow-[inset_0_0_0_1px_oklch(1_0_0/0.08)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `translateX(${Math.max(0, index) * 100}%)` }}
      />
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const checked = o.value === preference;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.label}
            title={o.label}
            onClick={() => setPreference(o.value)}
            className={cn(
              "relative z-10 flex items-center justify-center rounded-[4px] outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              checked ? "text-sidebar-foreground" : "text-sidebar-legend hover:text-sidebar-foreground",
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.9} />
          </button>
        );
      })}
    </div>
  );
}

/** Collapsed-rail variant: one key that steps through the three positions. */
export function ThemeCycleButton({ className }: { className?: string }): React.ReactElement {
  const { preference, setPreference } = useTheme();
  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === preference));
  const current = OPTIONS[index] ?? OPTIONS[0]!;
  const next = OPTIONS[(index + 1) % OPTIONS.length] ?? OPTIONS[0]!;
  const Icon = current.icon;
  return (
    <button
      type="button"
      onClick={() => setPreference(next.value)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`Theme: ${current.label}`}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-sidebar-legend outline-none transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className,
      )}
    >
      <Icon className="size-4" strokeWidth={1.9} />
    </button>
  );
}

/** Page-context variant (Settings): labelled segmented control on panel tokens. */
export function ThemeSegmented({ className }: { className?: string }): React.ReactElement {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn("inline-flex h-9 items-center gap-0.5 rounded-lg border border-border bg-secondary p-[3px]", className)}
    >
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const checked = o.value === preference;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => setPreference(o.value)}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded-md px-3 text-[13px] font-medium outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring",
              checked
                ? "bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.12),0_0_0_1px_var(--border)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.9} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
