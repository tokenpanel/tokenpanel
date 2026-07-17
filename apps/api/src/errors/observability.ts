/**
 * Observability hooks for errors (task 4.10): request/trace IDs, redaction,
 * structured log field shapes. Minimal — no exporter binding yet.
 */

import { randomBytes } from "node:crypto";
import type { AppError, AppErrorTag } from "./families.ts";
import { appErrorCode, appErrorTag, isAppError } from "./families.ts";
import type { HttpSurface } from "./variants.ts";

/** Correlation identifiers attached to requests and worker iterations. */
export type CorrelationIds = {
  readonly requestId: string;
  readonly traceId: string;
};

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newCorrelationIds(): CorrelationIds {
  return { requestId: newRequestId(), traceId: newTraceId() };
}

/** Log levels used by error policy / boundary. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured fields for application logs. Secrets never belong here —
 * use redact* helpers before assignment.
 */
export type StructuredLogFields = {
  readonly level: LogLevel;
  readonly message: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly errorTag?: AppErrorTag;
  readonly errorCode?: string;
  readonly surface?: HttpSurface;
  readonly operation?: string;
  readonly organizationId?: string;
  readonly customerId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly retryClass?: string;
  readonly fallbackClass?: string;
  readonly httpStatus?: number;
  /** Bounded private diagnostic — never sent to clients. */
  readonly privateDiagnostic?: string;
  readonly interrupted?: boolean;
  readonly defect?: boolean;
};

const SECRET_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|password|secret|token|jwt|credential)$/i;

const SECRET_VALUE =
  /(?:bearer\s+)[a-z0-9._\-+=\/]+|sk-[a-zA-Z0-9]{8,}|tp_(?:live|mgmt)_[a-zA-Z0-9]+|mongodb(?:\+srv)?:\/\/[^\s]+/gi;

const REDACTED = "[REDACTED]";

export function redactString(value: string, maxLen = 500): string {
  const sliced = value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  return sliced.replace(SECRET_VALUE, REDACTED);
}

/** Redact header map (Authorization, cookies, API keys). */
export function redactHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactString(v, 200);
    }
  }
  return out;
}

/**
 * Redact MongoDB URIs and other connection strings (credentials in authority).
 */
export function redactUri(uri: string): string {
  try {
    // mongodb+srv://user:pass@host/db → mongodb+srv://***:***@host/db
    return uri.replace(
      /(mongodb(?:\+srv)?:\/\/)([^/@]+)@/i,
      `$1${REDACTED}@`,
    ).replace(
      /(https?:\/\/)([^/@\s]+)@/i,
      `$1${REDACTED}@`,
    );
  } catch {
    return REDACTED;
  }
}

/** Deep-ish redaction for structured unknown values (bounded). */
export function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactUnknown(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ > 40) {
        out["…"] = "truncated";
        break;
      }
      if (SECRET_KEY.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactUnknown(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function logFieldsForAppError(
  err: AppError,
  ctx: {
    level: LogLevel;
    correlation?: CorrelationIds;
    surface?: HttpSurface;
    operation?: string;
  },
): StructuredLogFields {
  const base: StructuredLogFields = {
    level: ctx.level,
    message: err.message,
    errorTag: appErrorTag(err),
    errorCode: appErrorCode(err),
    ...(ctx.correlation !== undefined
      ? { requestId: ctx.correlation.requestId, traceId: ctx.correlation.traceId }
      : {}),
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    ...(ctx.operation !== undefined ? { operation: ctx.operation } : {}),
  };

  if (
    err._tag === "ProviderRejectedError" ||
    err._tag === "ProviderUnavailableError" ||
    err._tag === "ProviderTimeoutError" ||
    err._tag === "ProviderProtocolError"
  ) {
    return {
      ...base,
      retryClass: err.retryClass,
      fallbackClass: err.fallbackClass,
      ...(err.provider !== undefined ? { provider: err.provider } : {}),
      ...(err.model !== undefined ? { model: err.model } : {}),
      ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
      ...(err.diagnostic !== undefined
        ? { privateDiagnostic: redactString(err.diagnostic) }
        : {}),
    };
  }

  if (
    err._tag === "PersistenceUnavailableError" ||
    err._tag === "PersistenceTimeoutError" ||
    err._tag === "PersistenceDataError"
  ) {
    return {
      ...base,
      retryClass: err.retryClass,
      ...(err.diagnostic !== undefined
        ? { privateDiagnostic: redactString(err.diagnostic) }
        : {}),
    };
  }

  if (err._tag === "AuthenticationError" && err.privateReason !== undefined) {
    return {
      ...base,
      privateDiagnostic: redactString(err.privateReason),
    };
  }

  if (err._tag === "SystemError" && err.diagnostic !== undefined) {
    return {
      ...base,
      privateDiagnostic: redactString(err.diagnostic),
      defect: false,
    };
  }

  return base;
}

export function logFieldsForDefect(
  cause: unknown,
  ctx: {
    correlation?: CorrelationIds;
    surface?: HttpSurface;
    operation?: string;
  },
): StructuredLogFields {
  const msg =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "defect";
  return {
    level: "error",
    message: "Unhandled defect",
    defect: true,
    privateDiagnostic: redactString(
      cause instanceof Error
        ? `${cause.name}: ${cause.message}\n${cause.stack ?? ""}`
        : msg,
      2000,
    ),
    ...(ctx.correlation !== undefined
      ? { requestId: ctx.correlation.requestId, traceId: ctx.correlation.traceId }
      : {}),
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    ...(ctx.operation !== undefined ? { operation: ctx.operation } : {}),
  };
}

export function logFieldsForInterruption(ctx: {
  correlation?: CorrelationIds;
  surface?: HttpSurface;
  operation?: string;
}): StructuredLogFields {
  return {
    level: "info",
    message: "Request interrupted",
    interrupted: true,
    ...(ctx.correlation !== undefined
      ? { requestId: ctx.correlation.requestId, traceId: ctx.correlation.traceId }
      : {}),
    ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
    ...(ctx.operation !== undefined ? { operation: ctx.operation } : {}),
  };
}

/** Extract private diagnostic from AppError or unknown. */
export function privateDiagnosticOf(err: unknown): string | undefined {
  if (!isAppError(err)) {
    if (err instanceof Error) return redactString(err.message);
    return undefined;
  }
  if ("diagnostic" in err && typeof err.diagnostic === "string") {
    return redactString(err.diagnostic);
  }
  if (err._tag === "AuthenticationError" && err.privateReason !== undefined) {
    return redactString(err.privateReason);
  }
  return undefined;
}
