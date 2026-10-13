import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface FieldProps {
  id: string;
  label: string;
  /** Always-visible muted helper text below the input. */
  hint?: string | undefined;
  /** Hover tooltip text for platform-specific fields. Renders an (i) icon next to the label. */
  tooltip?: string | undefined;
  /** Destructive validation error text below the input. */
  error?: string | undefined;
  /** Extra classes for the outer wrapper. */
  className?: string | undefined;
  /** Renders a muted "(optional)" marker next to the label. */
  optional?: boolean | undefined;
  children: React.ReactNode;
}

/**
 * Shared labeled form field with optional tooltip, hint, and error slots.
 *
 * The label row uses `min-h-[1.25rem]` + `items-end` so that in multi-column
 * layouts, inputs align regardless of whether the label wraps to multiple lines.
 */
function Field({
  id,
  label,
  hint,
  tooltip,
  error,
  className,
  optional,
  children,
}: FieldProps): React.ReactElement {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-[1.25rem] items-end gap-1">
        <Label htmlFor={id}>
          {label}
          {optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}
        </Label>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Info: ${tooltip}`}
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[220px] text-center leading-snug">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {children}
      {error ? <span role="alert" className="text-xs font-medium text-destructive">{error}</span> : null}
      {hint && !error ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export { Field };
export type { FieldProps };
