import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium select-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[inset_0_-1px_0_oklch(0_0_0/0.18),0_1px_2px_oklch(0_0_0/0.12)] hover:bg-[color-mix(in_oklch,var(--primary)_88%,black)] active:shadow-[inset_0_1px_0_oklch(0_0_0/0.18)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[inset_0_-1px_0_oklch(0_0_0/0.18),0_1px_2px_oklch(0_0_0/0.12)] hover:bg-[color-mix(in_oklch,var(--destructive)_88%,black)]",
        outline:
          "border border-input bg-card text-foreground shadow-[0_1px_0_oklch(0_0_0/0.04)] hover:bg-accent hover:border-[color-mix(in_oklch,var(--input)_70%,var(--foreground))]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary)_90%,var(--foreground))]",
        ghost: "text-foreground hover:bg-accent",
        "ghost-destructive": "text-destructive hover:bg-destructive/10",
        link: "h-auto px-0 text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-2.5 text-[13px] [&_svg]:size-3.5",
        lg: "h-10 px-5",
        icon: "size-9",
        "icon-sm": "size-8 [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps): React.ReactElement {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };