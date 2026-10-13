import * as React from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Empty state that says what belongs here and how to add it. */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="text-muted-foreground [&_svg]:size-6 [&_svg]:stroke-[1.5]" aria-hidden>
          {icon}
        </div>
      ) : null}
      <div className="flex flex-col items-center gap-1">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {description ? (
          <p className="max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
