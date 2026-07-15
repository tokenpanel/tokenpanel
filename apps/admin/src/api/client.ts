import { adminPublicConfig } from "../config/public.ts";

const TOKEN_KEY = "tp_admin_token";

// Empty string = same-origin. In dev Vite proxies /admin, /v1, /health to the
// api service. In prod the api serves the admin SPA itself. Override only when
// the admin and api must live on different origins (see adminPublicConfig).
const API_BASE = adminPublicConfig.apiBaseUrl;

export const AUTH_TOKEN_KEY = TOKEN_KEY;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore quota / privacy mode */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type FetchOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  signal?: AbortSignal;
};

export const AUTH_INVALIDATED_EVENT = "tp:auth-invalidated";

function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const isBodyPresent = body !== undefined && body !== null;

  const finalHeaders: Record<string, string> = {
    ...authHeader(),
    ...((headers as Record<string, string> | undefined) ?? {}),
  };

  if (isBodyPresent && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers: finalHeaders,
      body: isBodyPresent ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, "network_error", { cause: String(err) });
  }

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT));
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const parsed = isJson ? await res.json().catch(() => null) : await res.text().catch(() => null);

  if (!res.ok) {
    const message =
      (isJson && parsed && typeof parsed === "object" && "message" in parsed && typeof (parsed as { message: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : null) ?? `request_failed_${res.status}`;
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T;
}

export function getJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(path, { ...options, method: "GET" });
}

export function postJson<T>(path: string, body?: unknown, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(path, { ...options, method: "POST", body: body ?? {} });
}

export function patchJson<T>(path: string, body?: unknown, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(path, { ...options, method: "PATCH", body: body ?? {} });
}

export function deleteJson<T>(path: string, options?: FetchOptions): Promise<T> {
  return apiFetch<T>(path, { ...options, method: "DELETE" });
}

export { apiFetch };