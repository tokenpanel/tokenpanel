import { Check, Copy, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One-time secret reveal (API keys, management keys, invite links). The
 * secret is never retrievable again, so the copy action is the primary key.
 */
export function OneTimeSecret({
  label,
  secret,
  copied,
  onCopy,
  onDismiss,
  className,
}: {
  label: string;
  secret: string;
  copied: boolean;
  onCopy: () => void;
  onDismiss?: () => void;
  className?: string;
}): React.ReactElement {
  return (
    <div
      role="status"
      data-slot="one-time-secret"
      className={cn("mb-4 rounded-lg border border-signal/45 bg-card p-3.5", className)}
    >
      <div className="mb-2.5 flex items-start gap-2 text-sm font-medium">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-signal" />
        <span className="flex-1">{label}</span>
        {onDismiss ? (
          <Button variant="ghost" size="sm" className="-my-1 -mr-1.5 h-7" onClick={onDismiss}>
            Done
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <code className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted px-2.5 py-2 font-mono text-xs leading-relaxed">
          {secret}
        </code>
        <Button size="sm" className="h-auto min-h-8 shrink-0" onClick={onCopy}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
