import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_1px_oklch(0_0_0/0.04)] transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-[color-mix(in_oklch,var(--input)_70%,var(--foreground))] focus-visible:outline-none focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };