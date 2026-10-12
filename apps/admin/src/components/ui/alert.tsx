import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-foreground",
  {
    variants: {
      variant: {
        default: "border-border [&>svg]:text-muted-foreground",
        destructive: "border-destructive/45 [&>svg]:text-destructive",
        success: "border-success/45 [&>svg]:text-success",
        warning: "border-warning/55 [&>svg]:text-warning",
        info: "border-signal/40 [&>svg]:text-signal",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

interface AlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof alertVariants> {}

const icons = {
  default: Info,
  destructive: AlertCircle,
  success: CheckCircle2,
  warning: AlertCircle,
  info: Info,
} as const;

function Alert({ className, variant = "default", children, ...props }: AlertProps): React.ReactElement {
  const Icon = variant && variant !== "default" ? icons[variant] : icons.default;
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="flex-1">{children}</div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"h5">): React.ReactElement {
  return (
    <h5
      data-slot="alert-title"
      className={cn("mb-1 font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-sm text-foreground/85 [&_p]:leading-relaxed", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };