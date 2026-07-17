import * as React from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  /** Lucide (or other) icon node — shown in a neutral mark next to the title. */
  icon?: React.ReactNode;
  /** Optional supporting line. Prefer short; omit when the title is enough. */
  description?: string;
  children?: React.ReactNode;
  className?: string;
}

/**
 * Page title band: icon mark + title + actions on a solid surface.
 */
export function PageHeader({
  title,
  icon,
  description,
  children,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <header
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3.5 sm:flex-row sm:justify-between sm:px-5 sm:py-4",
        description ? "sm:items-start" : "sm:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        {icon ? (
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              "border border-border bg-muted text-muted-foreground",
              "[&_svg]:size-[1.125rem]",
            )}
            aria-hidden
          >
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex flex-col gap-0.5">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="truncate text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:pt-0.5">
          {children}
        </div>
      ) : null}
    </header>
  );
}
