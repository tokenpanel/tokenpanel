import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">): React.ReactElement {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm text-foreground shadow-[inset_0_1px_1px_oklch(0_0_0/0.04)] transition-[border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground/80 hover:border-[color-mix(in_oklch,var(--input)_70%,var(--foreground))] focus-visible:outline-none focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };