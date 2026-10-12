import { Link } from "react-router-dom";
import { hasPermission, useAuth } from "../auth/AuthContext.tsx";
import type { PanelPermission } from "../auth/AuthContext.tsx";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ShieldX } from "lucide-react";

/**
 * Route guard: authenticated users must hold `permission` (admins always pass).
 * Pass `permission={null}` for routes that only need auth (orgs, settings).
 */
export default function RequirePermission({
  permission,
  children,
}: {
  permission: PanelPermission | null;
  children: React.ReactNode;
}): React.ReactElement {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-hidden>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (permission !== null && !hasPermission(user, permission)) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border px-6 py-12 text-center">
        <ShieldX className="size-6 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <div className="flex max-w-md flex-col gap-1.5">
          <h1 className="text-lg font-semibold">Access denied</h1>
          <p className="text-sm text-muted-foreground">
            Opening this page needs the{" "}
            <code className="rounded-[4px] bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
              {permission}
            </code>{" "}
            permission. Ask an organization admin to grant it.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
