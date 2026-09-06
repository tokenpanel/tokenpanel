/**
 * Hono ↔ Effect boundary adapter tests (section 10 / 13.8).
 *
 * Covers apps/api/src/http/adapters/boundary.ts:
 * - runDomainEffect: success / typed failure / defect rendering + correlation headers
 * - mapExitToHttpResponse: success / failure / defect / interruption directly
 * - surface shorthands: runAdminEffect / runManagementEffect / runOpenAIEffect / runAnthropicEffect
 *
 * Exits are constructed via Exit.succeed / Exit.fail / Exit.die / Exit.interrupt
 * (FiberId.none); runtime-backed tests use makeAppTestLayer + createAppRuntime({install:true}).
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Effect, Exit, FiberId, Layer } from "effect";
import type { Context } from "hono";
import {
  runDomainEffect,
  mapExitToHttpResponse,
  runAdminEffect,
  runManagementEffect,
  runOpenAIEffect,
  runAnthropicEffect,
} from "../adapters/boundary.ts";
import type { RenderedHttpError } from "../renderers/types.ts";
import { AuthenticationError } from "../../errors/families.ts";
import type {
  CorrelationIds,
  StructuredLogFields,
} from "../../errors/observability.ts";
import {
  createAppRuntime,
  disposeAppRuntime,
  clearAppRuntimeSingleton,
} from "../../runtime/app-runtime.ts";
import { makeAppTestLayer } from "../../runtime/layers/test.ts";
import type { AppServices } from "../../runtime/layers/live.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Hono Context: only req.raw (Request with AbortSignal) is read. */
function makeCtx(url = "http://localhost/test"): Context {
  return { req: { raw: new Request(url) } } as unknown as Context;
}

const CORR: CorrelationIds = {
  requestId: "req-boundary-1",
  traceId: "trace-boundary-1",
};

const noopLog = (): void => {};

function collectLogs(): {
  lines: StructuredLogFields[];
  log: (fields: StructuredLogFields) => void;
} {
  const lines: StructuredLogFields[] = [];
  return { lines, log: (f) => lines.push(f) };
}

const teapot: RenderedHttpError = {
  status: 418,
  body: { error: "teapot" },
  headers: {},
};

beforeAll(() => {
  const layer = makeAppTestLayer() as Layer.Layer<AppServices, never>;
  createAppRuntime(layer, { install: true });
});

afterAll(async () => {
  await disposeAppRuntime();
  clearAppRuntimeSingleton();
});

// ---------------------------------------------------------------------------
// runDomainEffect — success
// ---------------------------------------------------------------------------

test("runDomainEffect: success renders domain value as JSON with correlation headers", async () => {
  const res = await runDomainEffect(
    makeCtx(),
    Effect.succeed({ ok: true, echo: "boundary" }),
    { surface: "admin", correlation: CORR, log: noopLog },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  expect(res.headers.get("x-trace-id")).toBe(CORR.traceId);
  expect(await res.json()).toEqual({ ok: true, echo: "boundary" });
});

test("runDomainEffect: generated correlation when none injected (unique per request)", async () => {
  const res1 = await runDomainEffect(makeCtx(), Effect.succeed({ ok: true }), {
    surface: "admin",
    log: noopLog,
  });
  const res2 = await runDomainEffect(makeCtx(), Effect.succeed({ ok: true }), {
    surface: "admin",
    log: noopLog,
  });
  const id1 = res1.headers.get("x-request-id");
  const id2 = res2.headers.get("x-request-id");
  expect(id1).toBeTruthy();
  expect(id2).toBeTruthy();
  expect(id1).not.toBe(id2);
  expect(res1.headers.get("x-trace-id")).toBeTruthy();
});

test("runDomainEffect: successStatus override is honored", async () => {
  const res = await runDomainEffect(
    makeCtx(),
    Effect.succeed({ created: true }),
    { surface: "admin", successStatus: 201, log: noopLog },
  );
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ created: true });
});

test("runDomainEffect: async mapSuccess replaces default rendering", async () => {
  const res = await runDomainEffect(makeCtx(), Effect.succeed({ id: 7 }), {
    surface: "admin",
    log: noopLog,
    mapSuccess: async (value) =>
      new Response(`custom:${String((value as { id: number }).id)}`, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("custom:7");
});

// ---------------------------------------------------------------------------
// runDomainEffect — failure / defect
// ---------------------------------------------------------------------------

test("runDomainEffect: typed AppError failure maps through surface renderer (401 unauthorized)", async () => {
  const { lines, log } = collectLogs();
  const res = await runDomainEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({
        code: "unauthorized",
        message: "token rejected",
      }),
    ),
    {
      surface: "admin",
      operation: "op.test",
      correlation: CORR,
      log,
    },
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  const body = (await res.json()) as { error: string };
  expect(body).toEqual({ error: "unauthorized" });
  // Structured log carries the typed error, never raw message-only noise.
  const typedLine = lines.find((l) => l.errorTag === "AuthenticationError");
  expect(typedLine).toBeDefined();
  expect(typedLine?.errorCode).toBe("unauthorized");
  expect(typedLine?.surface).toBe("admin");
  expect(typedLine?.operation).toBe("op.test");
});

test("runDomainEffect: defect (die) renders sanitized 500 and logs private diagnostic", async () => {
  const { lines, log } = collectLogs();
  const res = await runDomainEffect(
    makeCtx(),
    Effect.die(new Error("boom: raw stack detail")),
    { surface: "admin", operation: "op.test", correlation: CORR, log },
  );
  expect(res.status).toBe(500);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: "internal_server_error" });
  expect(text).not.toContain("raw stack detail");
  const defectLine = lines.find((l) => l.defect === true);
  expect(defectLine).toBeDefined();
  expect(defectLine?.level).toBe("error");
});

test("runDomainEffect: untyped failure never leaks raw err.message (rendered as defect 500)", async () => {
  const res = await runDomainEffect(
    makeCtx(),
    Effect.fail({ leak: "super-secret-driver-text" }),
    { surface: "admin", log: noopLog },
  );
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: "internal_server_error" });
  expect(text).not.toContain("super-secret-driver-text");
});

test("runDomainEffect: mapError override wins; null falls through to surface renderer", async () => {
  const overridden = await runDomainEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({ code: "unauthorized", message: "nope" }),
    ),
    {
      surface: "admin",
      correlation: CORR,
      log: noopLog,
      mapError: () => teapot,
    },
  );
  expect(overridden.status).toBe(418);
  expect(overridden.headers.get("x-request-id")).toBe(CORR.requestId);
  expect(await overridden.json()).toEqual({ error: "teapot" });

  const fallenThrough = await runDomainEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({ code: "unauthorized", message: "nope" }),
    ),
    {
      surface: "admin",
      log: noopLog,
      mapError: () => null,
    },
  );
  expect(fallenThrough.status).toBe(401);
  expect(await fallenThrough.json()).toEqual({ error: "unauthorized" });
});

test("runDomainEffect: aborted request signal → interruption 499 with no body", async () => {
  const ac = new AbortController();
  ac.abort();
  const ctx = {
    req: { raw: new Request("http://localhost/x", { signal: ac.signal }) },
  } as unknown as Context;
  const res = await runDomainEffect(ctx, Effect.never, {
    surface: "admin",
    correlation: CORR,
    log: noopLog,
  });
  expect(res.status).toBe(499);
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  expect(await res.text()).toBe("");
});

test("runDomainEffect: explicit runtime parameter is honored (no process singleton)", async () => {
  const layer = makeAppTestLayer() as Layer.Layer<AppServices, never>;
  const rt = createAppRuntime(layer);
  try {
    const res = await runDomainEffect(
      makeCtx(),
      Effect.succeed({ ok: true }),
      { surface: "admin", correlation: CORR, log: noopLog },
      rt,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  } finally {
    await rt.dispose();
  }
});

// ---------------------------------------------------------------------------
// mapExitToHttpResponse — direct
// ---------------------------------------------------------------------------

test("mapExitToHttpResponse: success with sync mapSuccess returns its Response", async () => {
  const res = mapExitToHttpResponse(
    Exit.succeed({ a: 1 }),
    makeCtx(),
    { surface: "admin", mapSuccess: () => new Response("sync-body") },
    [],
  );
  expect(res).toBeInstanceOf(Response);
  expect(await (res as Response).text()).toBe("sync-body");
});

test("mapExitToHttpResponse: default success unwraps value via JSON.stringify", async () => {
  const asString = mapExitToHttpResponse(
    Exit.succeed("plain"),
    makeCtx(),
    { surface: "admin", correlation: CORR },
    [],
  ) as Response;
  expect(asString.status).toBe(200);
  expect(await asString.text()).toBe('"plain"');

  const asNumber = mapExitToHttpResponse(
    Exit.succeed(42),
    makeCtx(),
    { surface: "admin" },
    [],
  ) as Response;
  expect(await asNumber.text()).toBe("42");

  const asNull = mapExitToHttpResponse(
    Exit.succeed(null),
    makeCtx(),
    { surface: "admin" },
    [],
  ) as Response;
  expect(await asNull.text()).toBe("null");
});

test("mapExitToHttpResponse: admin + invalid_credentials with custom message includes message", async () => {
  const res = mapExitToHttpResponse(
    Exit.fail(
      new AuthenticationError({
        code: "invalid_credentials",
        message: "Password does not match",
      }),
    ),
    makeCtx(),
    { surface: "admin", correlation: CORR },
    [
      new AuthenticationError({
        code: "invalid_credentials",
        message: "Password does not match",
      }),
    ],
  ) as Response;
  expect(res.status).toBe(401);
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  expect(await res.json()).toEqual({
    error: "invalid_credentials",
    message: "Password does not match",
  });
});

test("mapExitToHttpResponse: admin + default invalid_credentials message stays message-free", async () => {
  const err = new AuthenticationError({
    code: "invalid_credentials",
    message: "Invalid credentials",
  });
  const res = mapExitToHttpResponse(
    Exit.fail(err),
    makeCtx(),
    { surface: "admin" },
    [err],
  ) as Response;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid_credentials" });
});

test("mapExitToHttpResponse: password-change contract is admin-surface only", async () => {
  const err = new AuthenticationError({
    code: "invalid_credentials",
    message: "Password does not match",
  });
  const res = mapExitToHttpResponse(
    Exit.fail(err),
    makeCtx(),
    { surface: "management" },
    [err],
  ) as Response;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("mapExitToHttpResponse: mapError with empty causeFailures is skipped → renderer path", async () => {
  const err = new AuthenticationError({
    code: "unauthorized",
    message: "nope",
  });
  const res = mapExitToHttpResponse(
    Exit.fail(err),
    makeCtx(),
    { surface: "admin", mapError: () => teapot },
    [],
  ) as Response;
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("mapExitToHttpResponse: defect exit renders admin 500 envelope", async () => {
  const { lines, log } = collectLogs();
  const res = mapExitToHttpResponse(
    Exit.die(new Error("boom")),
    makeCtx(),
    { surface: "admin", log },
    [],
  ) as Response;
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "internal_server_error" });
  expect(lines.find((l) => l.defect === true)).toBeDefined();
});

test("mapExitToHttpResponse: interruption renders 499 with correlation headers and empty body", async () => {
  const res = mapExitToHttpResponse(
    Exit.interrupt(FiberId.none),
    makeCtx(),
    { surface: "admin", correlation: CORR },
    [],
  ) as Response;
  expect(res.status).toBe(499);
  expect(res.headers.get("x-request-id")).toBe(CORR.requestId);
  expect(res.headers.get("x-trace-id")).toBe(CORR.traceId);
  expect(await res.text()).toBe("");
});

// ---------------------------------------------------------------------------
// Surface shorthands
// ---------------------------------------------------------------------------

test("runAdminEffect: success maps domain value to 200 JSON", async () => {
  const res = await runAdminEffect(
    makeCtx(),
    Effect.succeed({ ok: true, scope: "admin" }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(await res.json()).toEqual({ ok: true, scope: "admin" });
});

test("runAdminEffect: options pass through (successStatus)", async () => {
  const res = await runAdminEffect(makeCtx(), Effect.succeed({ ok: true }), {
    successStatus: 202,
    log: noopLog,
  });
  expect(res.status).toBe(202);
});

test("runAdminEffect: failure renders admin envelope", async () => {
  const res = await runAdminEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({ code: "unauthorized", message: "nope" }),
    ),
  );
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("runManagementEffect: enumeration-safe 401 without message leak", async () => {
  const res = await runManagementEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({
        code: "unauthorized",
        message: "jwt signature verification failed",
      }),
    ),
  );
  expect(res.status).toBe(401);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: "unauthorized" });
  expect(text).not.toContain("jwt");
});

test("runOpenAIEffect: failure renders OpenAI envelope with typed error", async () => {
  const res = await runOpenAIEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({
        code: "unauthorized",
        message: "missing key",
      }),
    ),
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("content-type")).toBe("application/json");
  const body = (await res.json()) as {
    error: { type: string; code: string };
  };
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.code).toBe("unauthorized");
});

test("runAnthropicEffect: failure renders Anthropic error envelope", async () => {
  const res = await runAnthropicEffect(
    makeCtx(),
    Effect.fail(
      new AuthenticationError({
        code: "unauthorized",
        message: "missing key",
      }),
    ),
  );
  expect(res.status).toBe(401);
  const body = (await res.json()) as {
    type: string;
    error: { type: string };
  };
  expect(body.type).toBe("error");
  expect(body.error.type).toBe("authentication_error");
});
