import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 px-6 py-16 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/80 text-muted-foreground ring-1 ring-inset ring-border">
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        {description ? (
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-0.5">{action}</div> : null}
    </div>
  );
}