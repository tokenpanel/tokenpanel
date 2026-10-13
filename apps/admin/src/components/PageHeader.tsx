import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  /** Deprecated: page titles no longer carry icon tiles. Ignored. */
  icon?: React.ReactNode;
  /** One short line on what this page is for. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/** Page title row: title + purpose line left, primary actions right. */
export function PageHeader({
  title,
  description,
  children,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-[72ch] text-pretty text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">{children}</div>
      ) : null}
    </header>
  );
}
