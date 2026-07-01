import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { Skeleton } from "@/components/ui/skeleton";

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();

  // loading true OR status fetch failed (needsSetup === null): wait so we
  // don't misroute during a transient network/CORS error.
  if (loading || needsSetup === null) {
    return (
      <div className="flex min-h-screen flex-col gap-4 p-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (needsSetup && !user) {
    return <Navigate to="/signup" replace />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}