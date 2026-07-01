import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface TableSkeletonProps {
  rows?: number;
  cols?: number;
  className?: string;
}

export function TableSkeleton({ rows = 6, cols = 4, className }: TableSkeletonProps): React.ReactElement {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-4 border-b border-border bg-muted/40 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3.5", i === 0 ? "flex-1" : "w-24")} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b border-border px-4 py-3.5">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className={cn("h-4", i === 0 ? "flex-1" : "w-28")} />
          ))}
        </div>
      ))}
    </div>
  );
}