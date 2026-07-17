/**
 * Validation issue formatting (task 4.7).
 * - default_400: SafeParseError-shaped body { success: false, error: { name, issues } }
 * - field_422: { error: "validation_error", details: fieldErrors }
 * Never echo rejected secrets/passwords in messages.
 */

import {
  ValidationError,
  type ValidationIssue,
} from "../../errors/families.ts";
import { SAFE_MESSAGES } from "../../errors/safe-messages.ts";
import type { ValidationMode } from "../../errors/variants.ts";
import type { RenderedHttpError } from "./types.ts";
import { emptyHeaders } from "./types.ts";

const SENSITIVE_PATH =
  /password|secret|token|authorization|api[-_]?key|credential|jwt/i;

const SENSITIVE_MESSAGE =
  /received\s+["'].*["']|expected\s+["'].*["']/i;

/** Strip values from messages that might echo rejected secrets. */
export function sanitizeValidationMessage(path: string, message: string): string {
  if (SENSITIVE_PATH.test(path)) {
    return "Invalid value";
  }
  if (SENSITIVE_MESSAGE.test(message) && SENSITIVE_PATH.test(message)) {
    return "Invalid value";
  }
  // Avoid quoting raw input in public messages for sensitive fields.
  if (SENSITIVE_PATH.test(path) || /password/i.test(message)) {
    return "Invalid value";
  }
  // Cap length; drop obvious secret material.
  let msg = message.length > 200 ? `${message.slice(0, 200)}…` : message;
  msg = msg.replace(/(?:bearer\s+)[^\s]+/gi, "[REDACTED]");
  msg = msg.replace(/sk-[a-zA-Z0-9]{8,}/g, "[REDACTED]");
  return msg;
}

export function sanitizeFieldErrors(
  details: Readonly<Record<string, readonly string[] | undefined>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, msgs] of Object.entries(details)) {
    if (!msgs || msgs.length === 0) continue;
    out[path] = msgs.map((m) => sanitizeValidationMessage(path, m));
  }
  return out;
}

export function sanitizeIssues(
  issues: readonly ValidationIssue[],
): ValidationIssue[] {
  return issues.map((i) => ({
    path: i.path,
    message: sanitizeValidationMessage(i.path, i.message),
  }));
}

/**
 * Build a ValidationError from field-error style input (422 path).
 */
export function validationError422(
  details: Readonly<Record<string, readonly string[] | undefined>>,
  message = SAFE_MESSAGES.validation_error,
): ValidationError {
  return new ValidationError({
    code: "validation_error",
    message,
    mode: "field_422",
    details: sanitizeFieldErrors(details),
  });
}

/**
 * Build a ValidationError for default 400 SafeParseError-style contracts.
 */
export function validationError400(
  issues: readonly ValidationIssue[],
  message = SAFE_MESSAGES.validation_error,
): ValidationError {
  return new ValidationError({
    code: "validation_error",
    message,
    mode: "default_400",
    issues: sanitizeIssues(issues),
  });
}

/**
 * Render validation to admin/management-compatible body.
 */
export function renderValidationError(err: ValidationError): RenderedHttpError {
  if (err.mode === "field_422") {
    const details = err.details
      ? sanitizeFieldErrors(err.details)
      : {};
    return {
      status: 422,
      body: { error: "validation_error", details },
      headers: emptyHeaders(),
    };
  }
  // default_400: ParseError-shaped body (issues array + name)
  const issues = err.issues ? sanitizeIssues(err.issues) : [];
  return {
    status: 400,
    body: {
      success: false,
      error: {
        name: "ParseError",
        issues: issues.map((i) => ({
          path: i.path.length > 0 ? i.path.split(".") : [],
          message: i.message,
        })),
      },
    },
    headers: emptyHeaders(),
  };
}

export function statusForValidationMode(mode: ValidationMode): 400 | 422 {
  return mode === "field_422" ? 422 : 400;
}
