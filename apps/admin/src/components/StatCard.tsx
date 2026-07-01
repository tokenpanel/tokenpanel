import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const statCardIconWrap = cva(
  "flex size-9 shrink-0 items-center justify-center rounded-lg",
  {
    variants: {
      tone: {
        default: "bg-primary/10 text-primary",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        muted: "bg-muted text-muted-foreground",
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
    <Card className={cn("p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {loading ? (
            <Skeleton className="mt-0.5 h-7 w-20" />
          ) : (
            <span className="text-2xl font-bold tracking-tight tabular-nums">{value}</span>
          )}
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
        {icon ? (
          <div className={cn(statCardIconWrap({ tone }))}>
            {icon}
          </div>
        ) : null}
      </div>
    </Card>
  );
}