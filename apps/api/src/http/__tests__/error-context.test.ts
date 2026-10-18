import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { Exit } from "effect";
import {
  API_VERSION_HEADER,
  apiVersionMiddleware,
  notFoundResponse,
  resolveErrorStyle,
} from "../error-context.ts";
import { mapExitToHttpResponse } from "../adapters/boundary.ts";
import { sValidator } from "../validation/index.ts";
import { Schema } from "effect";
import {
  NotFoundError,
  ProviderRejectedError,
  type AppError,
} from "../../errors/families.ts";
import type { HttpSurface } from "../../errors/variants.ts";

const quietLog = () => {};

function failWith(surface: HttpSurface, err: AppError) {
  return (c: Parameters<typeof notFoundResponse>[0]) =>
    mapExitToHttpResponse(
      Exit.fail(err),
      c,
      { surface, log: quietLog },
      [err],
    );
}

const rejected = new ProviderRejectedError({
  code: "provider_rejected",
  message: "openai chatComplete failed (HTTP 401)",
  category: "auth",
  phase: "headers",
  retryClass: "never",
  fallbackClass: "ineligible",
  acceptanceClass: "not_accepted",
  streamCommitClass: "not_committed",
  httpStatus: 401,
  diagnostic: '{"error":{"message":"Incorrect API key provided"}}',
});

function makeApp() {
  const app = new Hono();
  app.use("*", apiVersionMiddleware);
  app.get(
    "/api/management/customers/:id",
    failWith("management", new NotFoundError({ code: "not_found", message: "Customer not found" })),
  );
  app.get("/api/management/bad-id", (c) => notFoundResponse(c));
  app.post("/v1/chat/completions", failWith("openai", rejected));
  app.post("/v1/messages", failWith("anthropic", rejected));
  app.post("/admin/providers/x/discover", failWith("admin", rejected));
  app.post(
    "/api/management/customers",
    sValidator("json", Schema.Struct({ name: Schema.String })),
    (c) => c.json({ ok: true }),
  );
  return app;
}

const v2 = { [API_VERSION_HEADER]: "2" };

describe("resolveErrorStyle", () => {
  test("admin is always standard with debug; header ignored", () => {
    expect(resolveErrorStyle("/admin/models", undefined)).toEqual({
      surface: "admin",
      standard: true,
      debug: true,
      version: null,
    });
    expect(resolveErrorStyle("/admin/models", "1").standard).toBe(true);
  });

  test("/v1 is always standard in its protocol format; header ignored", () => {
    for (const header of [undefined, "1", "2", "junk"]) {
      expect(resolveErrorStyle("/v1/chat/completions", header)).toEqual({
        surface: "openai",
        standard: true,
        debug: false,
        version: null,
      });
      expect(resolveErrorStyle("/v1/messages", header).surface).toBe("anthropic");
    }
  });

  test("management defaults to legacy version 1; 2 opts into the standard", () => {
    expect(resolveErrorStyle("/api/management/customers", undefined)).toMatchObject({
      surface: "management",
      standard: false,
      version: 1,
    });
    expect(resolveErrorStyle("/api/management/customers", " 2 ")).toMatchObject({
      surface: "management",
      standard: true,
      version: 2,
    });
  });
});

describe("version 1 responses are unchanged", () => {
  const app = makeApp();

  test("management not_found keeps { error: code } and echoes version 1", async () => {
    const res = await app.request(`/api/management/customers/abc`);
    expect(res.status).toBe(404);
    expect(res.headers.get(API_VERSION_HEADER)).toBe("1");
    expect(await res.json()).toEqual({ error: "not_found" });
    const bad = await app.request(`/api/management/bad-id`);
    expect(await bad.json()).toEqual({ error: "not_found" });
  });

  test("validation keeps the ParseError body", async () => {
    const res = await app.request("/api/management/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: { name: string } };
    expect(body.success).toBe(false);
    expect(body.error.name).toBe("ParseError");
  });
});

describe("/v1 follows the OpenAI/Anthropic error contracts (no header)", () => {
  const app = makeApp();

  test("OpenAI: 502 provider_rejected, x-should-retry false, no upstream detail", async () => {
    for (const headers of [{}, v2, { [API_VERSION_HEADER]: "junk" }]) {
      const res = await app.request("/v1/chat/completions", { method: "POST", headers });
      expect(res.status).toBe(502);
      expect(res.headers.get("x-should-retry")).toBe("false");
      expect(res.headers.get(API_VERSION_HEADER)).toBeNull();
      const text = await res.text();
      expect(text).not.toContain("Incorrect API key");
      expect(text).not.toContain("HTTP 401");
      expect(JSON.parse(text)).toEqual({
        error: {
          message: "The model provider rejected the request.",
          type: "server_error",
          param: null,
          code: "provider_rejected",
        },
      });
    }
  });

  test("Anthropic envelope", async () => {
    const res = await app.request("/v1/messages", { method: "POST" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        code: "provider_rejected",
        message: "The model provider rejected the request.",
      },
    });
  });
});

describe("Management API with TokenPanel-Version: 2 uses the catalogue", () => {
  const app = makeApp();

  test("management envelope", async () => {
    const res = await app.request(`/api/management/customers/abc`, { headers: v2 });
    expect(res.status).toBe(404);
    expect(res.headers.get(API_VERSION_HEADER)).toBe("2");
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "Customer not found" },
    });
  });

  test("validation_error lists issues", async () => {
    const res = await app.request("/api/management/customers", {
      method: "POST",
      headers: { ...v2, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { issues: { path: string }[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toStartWith("Invalid request: name:");
    expect(body.error.details.issues[0]!.path).toBe("name");
  });

  test("unsupported header value → 400 unsupported_api_version", async () => {
    const res = await app.request("/api/management/customers/abc", {
      headers: { [API_VERSION_HEADER]: "3" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "unsupported_api_version",
        message: "Unsupported TokenPanel-Version header. Supported versions: 1, 2.",
        details: { supportedVersions: [1, 2] },
      },
    });
  });
});

describe("admin API is standard with upstream debug", () => {
  test("provider failure shows classified message and redacted upstream body", async () => {
    const res = await makeApp().request("/admin/providers/x/discover", { method: "POST" });
    expect(res.status).toBe(502);
    expect(res.headers.get(API_VERSION_HEADER)).toBeNull();
    expect(await res.json()).toEqual({
      error: {
        code: "provider_rejected",
        message: "openai chatComplete failed (HTTP 401)",
        upstream: {
          status: 401,
          detail: '{"error":{"message":"Incorrect API key provided"}}',
        },
      },
    });
  });
});
