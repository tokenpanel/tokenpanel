import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, KeyRound, ShieldCheck, Zap } from "lucide-react";
import BrandLogo from "@/components/BrandLogo";

interface FromState {
  from?: { pathname: string };
}

export function fromPath(locationState: unknown): string {
  const state = locationState as FromState | null;
  return state?.from?.pathname ?? "/";
}

function BrandPanel(): React.ReactElement {
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, var(--sidebar-primary) 0, transparent 40%), radial-gradient(circle at 80% 80%, var(--sidebar-primary) 0, transparent 40%)",
        }}
      />
      <div className="relative flex items-center gap-2.5">
        <BrandLogo className="size-9 shadow-sm" />
        <span className="text-base font-semibold tracking-tight">TokenPanel</span>
      </div>
      <div className="relative flex flex-col gap-6">
        <h2 className="text-2xl font-semibold leading-tight tracking-tight">
          The control plane for<br />your AI services.
        </h2>
        <p className="max-w-sm text-sm text-sidebar-foreground/60">
          Track token usage, manage customer balances, enforce rolling rate limits,
          and resell AI APIs under your own brand.
        </p>
        <ul className="flex flex-col gap-3 text-sm text-sidebar-foreground/70">
          <li className="flex items-center gap-2.5">
            <Zap className="size-4 text-sidebar-primary" />
            OpenAI &amp; Anthropic-compatible proxy
          </li>
          <li className="flex items-center gap-2.5">
            <ShieldCheck className="size-4 text-sidebar-primary" />
            Per-customer budgets &amp; 5-hour rolling limits
          </li>
          <li className="flex items-center gap-2.5">
            <KeyRound className="size-4 text-sidebar-primary" />
            API keys with model whitelists
          </li>
        </ul>
      </div>
      <div className="relative text-xs text-sidebar-foreground/40">
        &copy; {new Date().getFullYear()} TokenPanel
      </div>
    </div>
  );
}

export default function LoginPage(): React.ReactElement {
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
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
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
    <div className="flex min-h-screen bg-background">
      <BrandPanel />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm animate-fade-in-up">
          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground">
              Sign in to your admin console
            </p>
          </div>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-username">Username</Label>
              <Input
                id="login-username"
                type="text"
                value={username}
                autoComplete="username"
                required
                disabled={submitting}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
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
          <p className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground">
            First time? Ask an admin to invite you.
          </p>
        </div>
      </div>
    </div>
  );
}
