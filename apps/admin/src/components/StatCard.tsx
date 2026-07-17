import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const statCardIconWrap = cva(
  "flex size-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
  {
    variants: {
      tone: {
        default: "bg-muted text-muted-foreground ring-border",
        success: "bg-success/10 text-success ring-success/15",
        warning: "bg-warning/10 text-warning ring-warning/15",
        destructive: "bg-destructive/10 text-destructive ring-destructive/15",
        muted: "bg-muted text-muted-foreground ring-border",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

interface StatCardProps {
  label: string;
  value: string;
  icon?: React.ReactNode;
  hint?: string;
  tone?: VariantProps<typeof statCardIconWrap>["tone"];
  loading?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  icon,
  hint,
  tone = "default",
  loading = false,
  className,
}: StatCardProps): React.ReactElement {
  return (
    <Card
      className={cn(
        "p-6 transition-colors duration-150 hover:border-border",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          {loading ? (
            <Skeleton className="h-9 w-24" />
          ) : (
            <span className="text-3xl font-semibold tracking-tight tabular-nums leading-none">
              {value}
            </span>
          )}
          {hint ? (
            <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
          ) : null}
        </div>
        {icon ? (
          <div className={cn(statCardIconWrap({ tone }))}>
            <span className="[&_svg]:size-5">{icon}</span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
