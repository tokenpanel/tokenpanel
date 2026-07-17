import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Sparkles } from "lucide-react";
import BrandLogo from "@/components/BrandLogo";

interface SignupForm {
  adminEmail: string;
  adminUsername: string;
  password: string;
  confirmPassword: string;
}

interface FieldErrors {
  adminEmail?: string;
  adminUsername?: string;
  password?: string;
  confirmPassword?: string;
}

const EMPTY: SignupForm = {
  adminEmail: "",
  adminUsername: "",
  password: "",
  confirmPassword: "",
};

const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validate(form: SignupForm): FieldErrors {
  const errs: FieldErrors = {};

  if (!form.adminEmail) {
    errs.adminEmail = "Email is required.";
  } else if (!EMAIL_RE.test(form.adminEmail)) {
    errs.adminEmail = "Enter a valid email address.";
  }

  if (!form.adminUsername) {
    errs.adminUsername = "Username is required.";
  } else if (form.adminUsername.length < 3 || form.adminUsername.length > 60) {
    errs.adminUsername = "Username must be 3–60 characters.";
  } else if (!USERNAME_RE.test(form.adminUsername)) {
    errs.adminUsername = "Use letters, numbers, dots, hyphens, or underscores only.";
  }

  if (!form.password) {
    errs.password = "Password is required.";
  } else if (form.password.length < 8) {
    errs.password = "Password must be at least 8 characters.";
  }

  if (!form.confirmPassword) {
    errs.confirmPassword = "Confirm your password.";
  } else if (form.password !== form.confirmPassword) {
    errs.confirmPassword = "Passwords do not match.";
  }

  return errs;
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
      <div className="relative flex flex-col gap-4">
        <div className="flex size-12 items-center justify-center rounded-xl bg-sidebar-primary/10">
          <Sparkles className="size-6 text-sidebar-primary" />
        </div>
        <h2 className="text-2xl font-semibold leading-tight tracking-tight">
          Set up your<br />AI control plane.
        </h2>
        <p className="max-w-sm text-sm text-sidebar-foreground/60">
          Create your admin account and organization to start managing providers,
          models, accounts, budgets, and usage.
        </p>
      </div>
      <div className="relative text-xs text-sidebar-foreground/40">
        &copy; {new Date().getFullYear()} TokenPanel
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export default function SignupPage(): React.ReactElement {
  const { user, loading, needsSetup, signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState<SignupForm>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  if (needsSetup === false) {
    return <Navigate to="/login" replace />;
  }

  function update<K extends keyof SignupForm>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errs = validate(form);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await signup({
        adminEmail: form.adminEmail.trim(),
        adminUsername: form.adminUsername.trim(),
        password: form.password,
        confirmPassword: form.confirmPassword,
      });
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 422 && err.body && typeof err.body === "object" && "details" in err.body) {
          const details = (err.body as { details?: Record<string, string[]> }).details;
          if (details) {
            const mapped: FieldErrors = {};
            for (const key of Object.keys(details) as (keyof FieldErrors)[]) {
              const msgs = details[key];
              const first = Array.isArray(msgs) ? msgs[0] : undefined;
              if (first !== undefined) {
                mapped[key] = first;
              }
            }
            setFieldErrors(mapped);
          }
        } else if (err.status === 409) {
          setError(err.message || "Setup could not be completed.");
        } else {
          setError(err.message || `Signup failed (${err.status}).`);
        }
      } else {
        setError("Signup failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-background">
      <BrandPanel />
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[460px] animate-fade-in-up">
          <div className="mb-6 flex flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Create your admin account</h1>
            <p className="text-sm text-muted-foreground">
              This becomes the first admin of your organization.
            </p>
          </div>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Field id="signup-email" label="Admin email" error={fieldErrors.adminEmail}>
              <Input
                id="signup-email"
                type="email"
                value={form.adminEmail}
                autoComplete="email"
                disabled={submitting}
                onChange={(e) => update("adminEmail", e.target.value)}
              />
            </Field>

            <Field id="signup-username" label="Admin username" error={fieldErrors.adminUsername}>
              <Input
                id="signup-username"
                type="text"
                value={form.adminUsername}
                autoComplete="username"
                disabled={submitting}
                onChange={(e) => update("adminUsername", e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="signup-password" label="Password" error={fieldErrors.password}>
                <PasswordInput
                  id="signup-password"
                  value={form.password}
                  autoComplete="new-password"
                  disabled={submitting}
                  showPassword={showPassword}
                  onToggleShow={() => setShowPassword((v) => !v)}
                  onChange={(e) => update("password", e.target.value)}
                />
              </Field>
              <Field id="signup-confirm" label="Confirm password" error={fieldErrors.confirmPassword}>
                <PasswordInput
                  id="signup-confirm"
                  value={form.confirmPassword}
                  autoComplete="new-password"
                  disabled={submitting}
                  showPassword={showPassword}
                  onToggleShow={() => setShowPassword((v) => !v)}
                  onChange={(e) => update("confirmPassword", e.target.value)}
                />
              </Field>
            </div>

            <p className="text-xs text-muted-foreground">
              A default organization is created for you automatically. You can rename it or create more after signing in.
            </p>

            <Button type="submit" className="mt-1 w-full" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create admin account"
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
