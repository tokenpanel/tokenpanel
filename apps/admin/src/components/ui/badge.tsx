import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-2 text-xs font-medium leading-none text-foreground transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-secondary",
        // Neutral chip (types, roles, aliases)
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        // Inactive / off: hollow ring
        off: "border-border bg-transparent text-muted-foreground before:size-[7px] before:rounded-full before:border-[1.5px] before:border-current before:content-['']",
        outline: "border-border bg-transparent",
        // Live / ok: filled disc
        success:
          "border-border bg-card before:size-[7px] before:rounded-full before:bg-success before:content-['']",
        // Attention: hollow orange ring
        warning:
          "border-border bg-card before:size-[7px] before:rounded-full before:border-[1.5px] before:border-warning before:content-['']",
        // Stopped / revoked: filled square
        destructive:
          "border-border bg-card before:size-[7px] before:rounded-[1px] before:bg-destructive before:content-['']",
        info:
          "border-border bg-card before:size-[7px] before:rotate-45 before:rounded-[1px] before:bg-signal before:content-['']",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };