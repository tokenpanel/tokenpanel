import { useMemo, useState, type FormEvent, type ReactElement } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import { AuthBrandPanel, AuthMobileBrand } from "@/components/AuthBrandPanel";

interface FirstRunForm {
  adminEmail: string;
  adminUsername: string;
  password: string;
  confirmPassword: string;
}

interface InviteForm {
  username: string;
  password: string;
  confirmPassword: string;
}

interface FieldErrors {
  adminEmail?: string;
  adminUsername?: string;
  username?: string;
  password?: string;
  confirmPassword?: string;
}

const EMPTY_FIRST: FirstRunForm = {
  adminEmail: "",
  adminUsername: "",
  password: "",
  confirmPassword: "",
};

const EMPTY_INVITE: InviteForm = {
  username: "",
  password: "",
  confirmPassword: "",
};

const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateFirstRun(form: FirstRunForm): FieldErrors {
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

export function validateInvite(form: InviteForm): FieldErrors {
  const errs: FieldErrors = {};

  if (!form.username) {
    errs.username = "Username is required.";
  } else if (form.username.length < 3 || form.username.length > 60) {
    errs.username = "Username must be 3–60 characters.";
  } else if (!USERNAME_RE.test(form.username)) {
    errs.username = "Use letters, numbers, dots, hyphens, or underscores only.";
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

/** @deprecated Use validateFirstRun — kept for existing unit tests. */
export function validate(form: FirstRunForm): FieldErrors {
  return validateFirstRun(form);
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
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export default function SignupPage(): ReactElement {
  const { user, loading, needsSetup, signup, acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteToken = useMemo(() => {
    const raw = searchParams.get("token");
    return raw && raw.trim().length > 0 ? raw.trim() : null;
  }, [searchParams]);
  const isInvite = inviteToken !== null;

  const [firstForm, setFirstForm] = useState<FirstRunForm>(EMPTY_FIRST);
  const [inviteForm, setInviteForm] = useState<InviteForm>(EMPTY_INVITE);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  // First-run only when no invite token. Invite accept works after setup.
  if (!isInvite && needsSetup === false) {
    return <Navigate to="/login" replace />;
  }

  // Invite link while instance still needs first admin — send them to first-run.
  if (isInvite && needsSetup === true) {
    return <Navigate to="/signup" replace />;
  }

  function updateFirst<K extends keyof FirstRunForm>(key: K, value: string) {
    setFirstForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function updateInvite<K extends keyof InviteForm>(key: K, value: string) {
    setInviteForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function onSubmitFirst(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errs = validateFirstRun(firstForm);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await signup({
        adminEmail: firstForm.adminEmail.trim(),
        adminUsername: firstForm.adminUsername.trim(),
        password: firstForm.password,
        confirmPassword: firstForm.confirmPassword,
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

  async function onSubmitInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!inviteToken) return;
    const errs = validateInvite(inviteForm);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await acceptInvite({
        token: inviteToken,
        username: inviteForm.username.trim(),
        password: inviteForm.password,
      });
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 410) {
          setError("This invite has expired. Ask an admin for a new link.");
        } else if (err.status === 404) {
          setError("Invite is invalid or already used.");
        } else if (err.status === 401) {
          setError(
            "Invalid password. If you already have an account, use your existing password.",
          );
        } else if (err.status === 429) {
          setError("Too many attempts. Wait a few minutes and try again.");
        } else if (err.status === 409) {
          setError(err.message || "Username or email is already taken.");
        } else if (
          err.status === 422 &&
          err.body &&
          typeof err.body === "object" &&
          "details" in err.body
        ) {
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
        } else {
          setError(err.message || `Invite accept failed (${err.status}).`);
        }
      } else {
        setError("Invite accept failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <AuthBrandPanel />

      <main className="relative flex flex-1 flex-col justify-center px-6 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-[28rem] animate-fade-in-up">
          <AuthMobileBrand />

          <header className="mb-8 flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {isInvite ? "Accept your invite" : "Create your admin account"}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {isInvite
                ? "Choose a username and password to join the organization. If you already have an account with the invited email, enter your existing password."
                : "This becomes the first admin of your organization."}
            </p>
          </header>

          {isInvite ? (
            <form className="flex flex-col gap-5" onSubmit={onSubmitInvite} noValidate>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Field id="invite-username" label="Username" error={fieldErrors.username}>
                <Input
                  id="invite-username"
                  type="text"
                  value={inviteForm.username}
                  autoComplete="username"
                  autoFocus
                  disabled={submitting}
                  onChange={(e) => updateInvite("username", e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field id="invite-password" label="Password" error={fieldErrors.password}>
                  <PasswordInput
                    id="invite-password"
                    value={inviteForm.password}
                    autoComplete="new-password"
                    disabled={submitting}
                    showPassword={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                    onChange={(e) => updateInvite("password", e.target.value)}
                  />
                </Field>
                <Field
                  id="invite-confirm"
                  label="Confirm password"
                  error={fieldErrors.confirmPassword}
                >
                  <PasswordInput
                    id="invite-confirm"
                    value={inviteForm.confirmPassword}
                    autoComplete="new-password"
                    disabled={submitting}
                    showPassword={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                    onChange={(e) => updateInvite("confirmPassword", e.target.value)}
                  />
                </Field>
              </div>

              <Button type="submit" className="mt-1 w-full" disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Joining…
                  </>
                ) : (
                  "Accept invite"
                )}
              </Button>
            </form>
          ) : (
            <form className="flex flex-col gap-5" onSubmit={onSubmitFirst} noValidate>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Field id="signup-email" label="Admin email" error={fieldErrors.adminEmail}>
                <Input
                  id="signup-email"
                  type="email"
                  value={firstForm.adminEmail}
                  autoComplete="email"
                  autoFocus
                  disabled={submitting}
                  onChange={(e) => updateFirst("adminEmail", e.target.value)}
                />
              </Field>

              <Field
                id="signup-username"
                label="Admin username"
                error={fieldErrors.adminUsername}
              >
                <Input
                  id="signup-username"
                  type="text"
                  value={firstForm.adminUsername}
                  autoComplete="username"
                  disabled={submitting}
                  onChange={(e) => updateFirst("adminUsername", e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field id="signup-password" label="Password" error={fieldErrors.password}>
                  <PasswordInput
                    id="signup-password"
                    value={firstForm.password}
                    autoComplete="new-password"
                    disabled={submitting}
                    showPassword={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                    onChange={(e) => updateFirst("password", e.target.value)}
                  />
                </Field>
                <Field
                  id="signup-confirm"
                  label="Confirm password"
                  error={fieldErrors.confirmPassword}
                >
                  <PasswordInput
                    id="signup-confirm"
                    value={firstForm.confirmPassword}
                    autoComplete="new-password"
                    disabled={submitting}
                    showPassword={showPassword}
                    onToggleShow={() => setShowPassword((v) => !v)}
                    onChange={(e) => updateFirst("confirmPassword", e.target.value)}
                  />
                </Field>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">
                A default organization is created for you automatically. You can
                rename it or create more after signing in.
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
          )}
        </div>
      </main>
    </div>
  );
}
