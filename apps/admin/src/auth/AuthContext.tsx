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
  AUTH_INVALIDATED_EVENT,
  clearToken,
  getJson,
  getToken,
  patchJson,
  postJson,
  setToken,
  ApiError,
} from "../api/client.ts";

export type UserRole = "admin" | "member";

export interface Membership {
  organizationId: string;
  role: UserRole;
}

export interface User {
  id: string;
  username: string;
  email: string;
  status: string;
  /** Role for the active organization (resolved from memberships). */
  role: UserRole;
  memberships: Membership[];
  activeOrganizationId: string;
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
            setUser(me);
            setNeedsSetup(false);
            setLoading(false);
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
    setUser(res.user);
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
      setUser(res.user);
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
      setUser((prev) =>
        prev
          ? {
              ...prev,
              activeOrganizationId: res.activeOrganizationId,
              role: res.role,
            }
          : prev,
      );
    },
    [],
  );

  const updateEmail = useCallback(async (email: string) => {
    const updated = await patchJson<User>("/admin/auth/me", { email });
    setUser((prev) => (prev ? { ...prev, email: updated.email } : prev));
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await postJson("/admin/auth/password", {
        currentPassword,
        newPassword,
        confirmNewPassword: newPassword,
      });
    },
    [],
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