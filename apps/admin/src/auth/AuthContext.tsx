import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  effectivePanelPermissions,
  hasPanelPermission,
  type PanelPermission,
} from "@tokenpanel/contracts";
import {
  AUTH_INVALIDATED_EVENT,
  clearToken,
  getJson,
  getToken,
  patchJson,
  postJson,
  setToken,
  ApiError,
} from "../api/client.ts";
import { tokenValidatedState } from "./bootstrap-state.ts";

export type UserRole = "admin" | "member";
export type { PanelPermission };

export interface Membership {
  organizationId: string;
  role: UserRole;
  /** Stored grants for this membership (empty for admins). */
  permissions: PanelPermission[];
}

export interface User {
  id: string;
  username: string;
  email: string;
  status: string;
  /** Role for the active organization (resolved from memberships). */
  role: UserRole;
  /**
   * Effective permissions for the active organization.
   * Admins receive the full catalog; members only their grants.
   */
  permissions: PanelPermission[];
  memberships: Membership[];
  activeOrganizationId: string;
}

/**
 * Admin always has every panel permission; members need an explicit grant.
 * Safe when `user` is null / permissions missing (treat as no access).
 */
export function hasPermission(
  user: Pick<User, "role" | "permissions"> | null | undefined,
  permission: PanelPermission,
): boolean {
  if (!user) return false;
  return hasPanelPermission(user.role, user.permissions ?? [], permission);
}

interface AuthStatusResponse {
  needsSetup: boolean;
}

interface LoginResponse {
  token: string;
  user: User;
}

interface SignupResponse {
  token: string;
  user: User;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  needsSetup: boolean | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (input: {
    adminEmail: string;
    adminUsername: string;
    password: string;
    confirmPassword: string;
  }) => Promise<void>;
  refreshStatus: () => Promise<void>;
  switchOrganization: (organizationId: string) => Promise<void>;
  updateEmail: (email: string) => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Normalize API user so missing permissions fields don't break the UI. */
function normalizeUser(raw: User): User {
  const memberships = (raw.memberships ?? []).map((m) => ({
    organizationId: m.organizationId,
    role: m.role,
    permissions: (m.permissions ?? []) as PanelPermission[],
  }));
  const role = raw.role;
  const effective =
    raw.permissions !== undefined && raw.permissions !== null
      ? (raw.permissions as PanelPermission[])
      : ([
          ...effectivePanelPermissions(
            role,
            memberships.find((m) => m.organizationId === raw.activeOrganizationId)
              ?.permissions,
          ),
        ] as PanelPermission[]);
  return {
    ...raw,
    permissions: effective,
    memberships,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await getJson<AuthStatusResponse>("/admin/auth/status");
      setNeedsSetup(status.needsSetup);
    } catch {
      // Leave needsSetup as null on fetch failure so pages render a neutral
      // state instead of falsely showing the login page (which masks the
      // real error, e.g. CORS/network). RootRedirect keeps the loading screen
      // when needsSetup is null and user is absent.
      setNeedsSetup(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const token = getToken();
      if (token) {
        try {
          const me = await getJson<User>("/admin/auth/me");
          if (!cancelled) {
            // tokenValidatedState centralizes the token-success invariant
            // (needsSetup MUST become false, not null) so it is unit-tested.
            const next = tokenValidatedState(normalizeUser(me));
            setUser(next.user);
            setNeedsSetup(next.needsSetup);
            setLoading(next.loading);
          }
          return;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            clearToken();
          }
        }
      }
      if (cancelled) return;
      await refreshStatus();
      if (!cancelled) setLoading(false);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  useEffect(() => {
    function onInvalidated() {
      setUser(null);
      void refreshStatus();
    }
    window.addEventListener(AUTH_INVALIDATED_EVENT, onInvalidated);
    return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, onInvalidated);
  }, [refreshStatus]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await postJson<LoginResponse>("/admin/auth/login", { username, password });
    setToken(res.token);
    setUser(normalizeUser(res.user));
    setNeedsSetup(false);
  }, []);

  const logout = useCallback(async () => {
    try {
      await postJson("/admin/auth/logout");
    } catch {
      /* best-effort */
    } finally {
      clearToken();
      setUser(null);
      void refreshStatus();
    }
  }, [refreshStatus]);

  const signup = useCallback(
    async (input: {
      adminEmail: string;
      adminUsername: string;
      password: string;
      confirmPassword: string;
    }) => {
      const res = await postJson<SignupResponse>("/admin/auth/signup", {
        adminEmail: input.adminEmail,
        adminUsername: input.adminUsername,
        password: input.password,
        confirmPassword: input.confirmPassword,
      });
      setToken(res.token);
      setUser(normalizeUser(res.user));
      setNeedsSetup(false);
    },
    [],
  );

  const switchOrganization = useCallback(
    async (organizationId: string) => {
      const res = await postJson<{
        token: string;
        activeOrganizationId: string;
        role: UserRole;
      }>("/admin/organizations/switch", { organizationId });
      setToken(res.token);
      setUser((prev) => {
        if (!prev) return prev;
        const membership = prev.memberships.find(
          (m) => m.organizationId === res.activeOrganizationId,
        );
        const role = res.role;
        const permissions = [
          ...effectivePanelPermissions(role, membership?.permissions ?? []),
        ] as PanelPermission[];
        return {
          ...prev,
          activeOrganizationId: res.activeOrganizationId,
          role,
          permissions,
        };
      });
    },
    [],
  );

  const updateEmail = useCallback(async (email: string) => {
    const updated = await patchJson<User>("/admin/auth/me", { email });
    setUser((prev) => (prev ? { ...prev, email: updated.email } : prev));
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      // Server revokes all allowlist sessions (including this browser).
      // Clear local token so the next request does not send a dead JWT.
      await postJson("/admin/auth/password", {
        currentPassword,
        newPassword,
        confirmNewPassword: newPassword,
      });
      clearToken();
      setUser(null);
      void refreshStatus();
    },
    [refreshStatus],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      needsSetup,
      login,
      logout,
      signup,
      refreshStatus,
      switchOrganization,
      updateEmail,
      changePassword,
    }),
    [
      user,
      loading,
      needsSetup,
      login,
      logout,
      signup,
      refreshStatus,
      switchOrganization,
      updateEmail,
      changePassword,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

/** Convenience hook: effective permission checks for the signed-in user. */
export function usePermissions(): {
  user: User | null;
  has: (permission: PanelPermission) => boolean;
} {
  const { user } = useAuth();
  return useMemo(
    () => ({
      user,
      has: (permission: PanelPermission) => hasPermission(user, permission),
    }),
    [user],
  );
}
