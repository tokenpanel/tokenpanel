import { useState, type FormEvent, type ReactElement } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import { AuthBrandPanel, AuthMobileBrand } from "@/components/AuthBrandPanel";
import { cn } from "@/lib/utils";

interface FromState {
  from?: { pathname: string };
}

export function fromPath(locationState: unknown): string {
  const state = locationState as FromState | null;
  return state?.from?.pathname ?? "/";
}

export default function LoginPage(): ReactElement {
  const { user, loading, needsSetup, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (needsSetup) {
    return <Navigate to="/signup" replace />;
  }

  if (user) {
    return <Navigate to={fromPath(location.state)} replace />;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(fromPath(location.state), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 401 ? "Invalid username or password." : err.message);
      } else {
        setError("Login failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <AuthBrandPanel />

      <main className="relative flex flex-1 flex-col justify-center px-6 py-10 sm:px-10">
        <div
          className={cn(
            "mx-auto w-full max-w-[22.5rem] animate-fade-in-up",
            "sm:max-w-[24rem]",
          )}
        >
          <AuthMobileBrand />

          <header className="mb-8 flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sign in to the admin console to manage usage, access, and limits.
            </p>
          </header>

          <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                type="text"
                value={username}
                autoComplete="username"
                autoFocus
                required
                disabled={submitting}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="login-password">Password</Label>
              <PasswordInput
                id="login-password"
                value={password}
                autoComplete="current-password"
                required
                disabled={submitting}
                showPassword={showPassword}
                onToggleShow={() => setShowPassword((v) => !v)}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <Button type="submit" className="mt-1 w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </form>

          <p className="mt-8 border-t border-border pt-5 text-center text-xs leading-relaxed text-muted-foreground">
            First time here? Ask an admin to invite you to the organization.
          </p>
        </div>
      </main>
    </div>
  );
}
