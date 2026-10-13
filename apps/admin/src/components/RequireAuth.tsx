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
      <div className="flex min-h-screen" aria-busy="true" aria-label="Loading">
        <div className="hidden w-[15.5rem] shrink-0 bg-sidebar md:block" />
        <div className="flex flex-1 flex-col gap-6 p-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-[104px] rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
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