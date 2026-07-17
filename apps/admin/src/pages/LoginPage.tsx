import { useState, type FormEvent, type ReactElement } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  KeyRound,
  ShieldCheck,
  Waypoints,
  Github,
  type LucideIcon,
} from "lucide-react";
import BrandLogo from "@/components/BrandLogo";
import { cn } from "@/lib/utils";

const GITHUB_REPO_URL = "https://github.com/tokenpanel/tokenpanel";

interface FromState {
  from?: { pathname: string };
}

export function fromPath(locationState: unknown): string {
  const state = locationState as FromState | null;
  return state?.from?.pathname ?? "/";
}

interface Capability {
  icon: LucideIcon;
  title: string;
  description: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    icon: Waypoints,
    title: "OpenAI & Anthropic-compatible gateway",
    description: "One governed API surface for your apps and teams.",
  },
  {
    icon: ShieldCheck,
    title: "Per-account budgets & rolling limits",
    description: "Cap spend, tokens, and requests over custom windows.",
  },
  {
    icon: KeyRound,
    title: "API keys with model access controls",
    description: "Issue scoped keys without exposing provider secrets.",
  },
];

function CapabilityRow({
  icon: Icon,
  title,
  description,
  index,
}: Capability & { index: number }): ReactElement {
  return (
    <li
      className="animate-fade-in-up flex gap-3.5 rounded-xl border border-sidebar-border/80 bg-sidebar-accent/35 p-3.5"
      style={{ animationDelay: `${0.12 + index * 0.06}s` }}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-sidebar-border bg-sidebar/60 text-sidebar-primary">
        <Icon className="size-4" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex flex-col gap-0.5 pt-0.5">
        <span className="text-sm font-medium leading-snug text-sidebar-foreground">
          {title}
        </span>
        <span className="text-[13px] leading-snug text-sidebar-foreground/50">
          {description}
        </span>
      </div>
    </li>
  );
}

function BrandPanel(): ReactElement {
  return (
    <aside className="relative hidden min-h-[100dvh] w-[min(50%,34rem)] shrink-0 flex-col justify-between overflow-hidden border-r border-sidebar-border bg-sidebar px-10 py-10 text-sidebar-foreground lg:flex xl:w-[min(48%,38rem)] xl:px-12">
      {/* Ambient depth: soft primary wash + faint grid */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          backgroundImage: [
            "radial-gradient(ellipse 80% 55% at 0% 0%, color-mix(in oklch, var(--sidebar-primary) 18%, transparent), transparent 55%)",
            "radial-gradient(ellipse 60% 40% at 100% 100%, color-mix(in oklch, var(--sidebar-primary) 10%, transparent), transparent 50%)",
          ].join(", "),
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        aria-hidden
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--sidebar-foreground) 1px, transparent 1px), linear-gradient(to bottom, var(--sidebar-foreground) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
          maskImage:
            "radial-gradient(ellipse 70% 60% at 50% 40%, black 20%, transparent 75%)",
        }}
      />

      <div className="relative flex items-center gap-2.5">
        <BrandLogo className="size-8 shadow-sm" />
        <span className="text-[15px] font-semibold tracking-tight">TokenPanel</span>
      </div>

      <div className="relative flex w-full flex-col gap-9">
        <div className="animate-fade-in-up flex flex-col gap-5">
          <div className="flex flex-col gap-2.5">
            <h2 className="text-[2rem] font-semibold leading-none tracking-tight xl:text-[2.375rem]">
              TokenPanel
            </h2>
            <p className="text-base font-medium leading-snug tracking-tight text-sidebar-foreground/80">
              AI spend control and access management
            </p>
          </div>
          <p className="w-full text-[15px] leading-relaxed text-sidebar-foreground/50">
            See what each account spends, decide who can call which models, and
            set budgets and rolling limits before costs run away. Issue scoped
            API keys and route traffic through one OpenAI- and
            Anthropic-compatible API without sharing provider credentials.
          </p>
        </div>

        <ul className="flex w-full flex-col gap-2.5">
          {CAPABILITIES.map((item, index) => (
            <CapabilityRow key={item.title} {...item} index={index} />
          ))}
        </ul>
      </div>

      <div className="relative flex items-center justify-between gap-4">
        <p className="text-xs text-sidebar-foreground/35">
          &copy; {new Date().getFullYear()} TokenPanel
        </p>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="TokenPanel on GitHub"
          className="inline-flex items-center gap-1.5 text-xs text-sidebar-foreground/45 no-underline transition-colors hover:text-sidebar-foreground/80"
        >
          <Github className="size-3.5" strokeWidth={1.75} aria-hidden />
          GitHub
        </a>
      </div>
    </aside>
  );
}

function MobileBrand(): ReactElement {
  return (
    <div className="mb-8 flex items-center gap-2.5 lg:hidden">
      <BrandLogo className="size-8 shadow-sm" />
      <span className="text-[15px] font-semibold tracking-tight">TokenPanel</span>
    </div>
  );
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
      <BrandPanel />

      <main className="relative flex flex-1 flex-col justify-center px-6 py-10 sm:px-10">
        <div
          className={cn(
            "mx-auto w-full max-w-[22.5rem] animate-fade-in-up",
            "sm:max-w-[24rem]",
          )}
        >
          <MobileBrand />

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
