import * as React from "react";
import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">): React.ReactElement {
  return (
    <div data-slot="table-wrapper" className="relative w-full overflow-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-[13.5px]", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">): React.ReactElement {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:border-border [&_tr:hover]:bg-transparent", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">): React.ReactElement {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">): React.ReactElement {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-rule transition-colors hover:bg-accent/60 data-[state=selected]:bg-accent",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">): React.ReactElement {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "legend h-9 px-3 text-left align-middle text-muted-foreground whitespace-nowrap first:pl-5 last:pr-5 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">): React.ReactElement {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-11 px-3 py-2 align-middle whitespace-nowrap first:pl-5 last:pr-5 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };