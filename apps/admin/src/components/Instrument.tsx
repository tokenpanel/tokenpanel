import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Panel: the near-white face plate every work area sits on. One elevation
 * (a hairline border), never nested inside another panel.
 */
export function Panel({
  className,
  as: Tag = "section",
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: React.ElementType }): React.ReactElement {
  return (
    <Tag
      className={cn("min-w-0 rounded-xl border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  );
}

/** Title row of a panel: heading left, optional actions right, ruled below. */
export function PanelHeader({
  title,
  description,
  actions,
  className,
  id,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  id?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex items-start justify-between gap-4 border-b border-rule px-5 py-3.5", className)}>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-[15px] font-semibold leading-tight">
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-pretty text-[13px] leading-snug text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="-my-1 flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Readout strip: a single ruled instrument row of printed legends over
 * condensed numerals. Replaces rows of same-size stat cards.
 */
export function ReadoutStrip({
  className,
  children,
  label,
  columns = 4,
}: {
  className?: string;
  children: React.ReactNode;
  label?: string;
  /** Desktop column count; mobile shows two per row. Keep children a multiple of both. */
  columns?: 2 | 3 | 4;
}): React.ReactElement {
  return (
    <Panel
      as="dl"
      aria-label={label}
      className={cn(
        "m-0 grid grid-cols-2 gap-px overflow-hidden bg-rule [&>*]:bg-card",
        columns === 4 && "lg:grid-cols-4",
        columns === 3 && "sm:grid-cols-3",
        className,
      )}
    >
      {children}
    </Panel>
  );
}

export function Readout({
  label,
  value,
  unit,
  hint,
  loading,
  className,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  loading?: boolean;
  className?: string;
  tone?: "destructive" | "warning";
}): React.ReactElement {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2 px-5 py-4", className)}>
      <dt className="legend text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-1">
        {loading ? (
          <span className="skeleton block h-[30px] w-20 rounded-sm" aria-hidden />
        ) : (
          <span
            className={cn(
              "readout flex items-baseline gap-1.5 truncate text-[28px] font-semibold leading-none",
              tone === "destructive" && "text-destructive",
              tone === "warning" && "text-warning",
            )}
          >
            {value}
            {unit ? <span className="text-[13px] font-medium text-muted-foreground">{unit}</span> : null}
          </span>
        )}
        {hint ? <span className="truncate text-xs text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}

/** Definition list in two columns: printed legend → value. */
export function SpecList({
  rows,
  className,
}: {
  rows: ReadonlyArray<{ label: string; value: React.ReactNode; key?: string } | null | false>;
  className?: string;
}): React.ReactElement {
  return (
    <dl className={cn("grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 text-sm", className)}>
      {rows.map((r) =>
        r ? (
          <div key={r.key ?? r.label} className="contents">
            <dt className="border-b border-rule py-2 text-muted-foreground">{r.label}</dt>
            <dd className="m-0 min-w-0 break-words border-b border-rule py-2">{r.value}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
