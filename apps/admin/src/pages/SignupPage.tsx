import { useMemo, useState, type FormEvent, type ReactElement } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.tsx";
import { ApiError } from "../api/client.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import { AuthLoading, AuthShell } from "@/components/AuthBrandPanel";

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


export default function SignupPage(): ReactElement {
  const { user, loading, needsSetup, signup, acceptInvite } = useAuth();
  const navigate = useNavigate();
  // Read the invite token from the URL FRAGMENT (e.g. `/signup#/token=…`)
  // rather than the query string. Query strings are logged in browser history,
  // Referer headers, and proxy/edge access logs — the opaque invite token must
  // not leak there. The fragment is never sent to servers in a normal request.
  const inviteToken = useMemo(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.replace(/^#\/?/, "");
    const params = new URLSearchParams(hash);
    const raw = params.get("token");
    return raw && raw.trim().length > 0 ? raw.trim() : null;
  }, []);
  const isInvite = inviteToken !== null;

  const [firstForm, setFirstForm] = useState<FirstRunForm>(EMPTY_FIRST);
  const [inviteForm, setInviteForm] = useState<InviteForm>(EMPTY_INVITE);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (loading) {
    return <AuthLoading />;
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
    <AuthShell
      title={isInvite ? "Accept your invite" : "Set up TokenPanel"}
      description={
        isInvite
          ? "Choose a username and password to join the organization. Already have an account with the invited email? Use your existing password."
          : "Create the first admin account for this instance. A default organization is created with it; you can rename it or add more later."
      }
    >
          {isInvite ? (
            <form className="flex flex-col gap-4" onSubmit={onSubmitInvite} noValidate>
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="invite-password" label="Password" hint="At least 8 characters." error={fieldErrors.password}>
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

              <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
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
            <form className="flex flex-col gap-4" onSubmit={onSubmitFirst} noValidate>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <Field id="signup-email" label="Email" error={fieldErrors.adminEmail}>
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
                label="Username"
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field id="signup-password" label="Password" hint="At least 8 characters." error={fieldErrors.password}>
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

              <Button type="submit" size="lg" className="mt-2 w-full" disabled={submitting}>
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
    </AuthShell>
  );
}
