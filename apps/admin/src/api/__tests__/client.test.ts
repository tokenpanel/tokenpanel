import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  ApiError,
  AUTH_INVALIDATED_EVENT,
  AUTH_TOKEN_KEY,
  apiFetch,
  getJson,
  postJson,
  patchJson,
  deleteJson,
} from "../client.ts";

const TOKEN_KEY = "tp_admin_token";

let origFetch: typeof fetch;
let fetchMock: (init?: RequestInit) => Promise<Response>;
let dispatched: CustomEvent[] = [];

beforeEach(() => {
  origFetch = globalThis.fetch;
  dispatched = [];
  localStorage.clear();
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    fetchMock(init)) as typeof fetch;
  (window as unknown as { dispatchEvent: (e: CustomEvent) => void }).dispatchEvent = (e: CustomEvent) => {
    dispatched.push(e);
  };
});

afterEach(() => {
  globalThis.fetch = origFetch;
  localStorage.clear();
});

test("AUTH_TOKEN_KEY + AUTH_INVALIDATED_EVENT constants", () => {
  expect(AUTH_TOKEN_KEY).toBe(TOKEN_KEY);
  expect(AUTH_INVALIDATED_EVENT).toBe("tp:auth-invalidated");
});

test("ApiError carries status/message/body + name", () => {
  const e = new ApiError(404, "not found", { error: "x" });
  expect(e.status).toBe(404);
  expect(e.message).toBe("not found");
  expect(e.body).toEqual({ error: "x" });
  expect(e.name).toBe("ApiError");
  expect(e).toBeInstanceOf(Error);
});

test("apiFetch: GET with token adds Authorization header, returns parsed JSON", async () => {
  localStorage.setItem(TOKEN_KEY, "tok");
  let sentInit: RequestInit | undefined;
  fetchMock = async (init) => {
    sentInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await getJson<{ ok: boolean }>("/admin/x");
  expect(r).toEqual({ ok: true });
  expect((sentInit?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
  expect(sentInit?.method).toBe("GET");
});

test("apiFetch: no token → no Authorization header", async () => {
  let sentInit: RequestInit | undefined;
  fetchMock = async (init) => {
    sentInit = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await getJson("/x");
  expect((sentInit?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
});

test("apiFetch: POST auto-adds Content-Type application/json + stringifies body", async () => {
  let sentInit: RequestInit | undefined;
  fetchMock = async (init) => {
    sentInit = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await postJson("/x", { a: 1 });
  expect((sentInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  expect(sentInit?.body).toBe(JSON.stringify({ a: 1 }));
  expect(sentInit?.method).toBe("POST");
});

test("apiFetch: PATCH + DELETE methods", async () => {
  let methods: string[] = [];
  fetchMock = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  await patchJson("/x", { a: 1 });
  await deleteJson("/x");
  expect(methods).toHaveLength(0);
});

test("apiFetch: 401 clears token + dispatches AUTH_INVALIDATED_EVENT", async () => {
  localStorage.setItem(TOKEN_KEY, "tok");
  fetchMock = async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { "content-type": "application/json" } });
  await expect(getJson("/x")).rejects.toBeInstanceOf(ApiError);
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(dispatched.length).toBeGreaterThan(0);
  expect(dispatched[0]?.type).toBe(AUTH_INVALIDATED_EVENT);
});

test("apiFetch: non-ok throws ApiError with message from body.message", async () => {
  fetchMock = async () => new Response('{"message":"bad request"}', { status: 400, headers: { "content-type": "application/json" } });
  await expect(getJson("/x")).rejects.toMatchObject({ status: 400, message: "bad request" });
});

test("apiFetch: non-ok without body.message → fallback request_failed_<status>", async () => {
  fetchMock = async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  await expect(getJson("/x")).rejects.toMatchObject({ status: 500, message: "request_failed_500" });
});

test("apiFetch: network error (fetch throws) → ApiError status 0 code network_error", async () => {
  fetchMock = async () => {
    throw new Error("connection refused");
  };
  await expect(getJson("/x")).rejects.toMatchObject({ status: 0 });
});

test("apiFetch: custom headers preserved + merged with auth", async () => {
  localStorage.setItem(TOKEN_KEY, "tok");
  let sentInit: RequestInit | undefined;
  fetchMock = async (init) => {
    sentInit = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await getJson("/x", { headers: { "X-Custom": "v" } });
  const h = sentInit?.headers as Record<string, string>;
  expect(h["Authorization"]).toBe("Bearer tok");
  expect(h["X-Custom"]).toBe("v");
});

test("apiFetch: non-JSON response returns text", async () => {
  fetchMock = async () => new Response("plain text", { status: 200, headers: { "content-type": "text/plain" } });
  const r = await apiFetch<string>("/x");
  expect(r).toBe("plain text");
});