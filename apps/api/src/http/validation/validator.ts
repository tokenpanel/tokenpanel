/**
 * Effect Schema Hono validator (`sValidator`).
 *
 * HTTP contracts:
 * - default failure → 400 + { success: false, error: { name: "ParseError", issues } }
 * - custom hooks may return 422 + { error: "validation_error", details }
 */
import type {
  Context,
  Env,
  Input,
  MiddlewareHandler,
  ValidationTargets,
} from "hono";
import { validator } from "hono/validator";
import { Either, ParseResult, Schema } from "effect";
import {
  sanitizeFieldErrors,
  sanitizeValidationMessage,
} from "../renderers/validation.ts";

export type ValidationTarget = keyof ValidationTargets;

export type EffectIssue = {
  readonly path: (string | number)[];
  readonly message: string;
};

export type EffectValidationError = {
  readonly name: "ParseError";
  readonly issues: readonly EffectIssue[];
  flatten(): {
    formErrors: string[];
    fieldErrors: Record<string, string[] | undefined>;
  };
};

export type EffectValidationSuccess<A> = {
  readonly success: true;
  readonly data: A;
};

export type EffectValidationFailure = {
  readonly success: false;
  readonly error: EffectValidationError;
};

export type EffectValidationResult<A> =
  | EffectValidationSuccess<A>
  | EffectValidationFailure;

function issuesFromParseError(err: ParseResult.ParseError): EffectIssue[] {
  const formatted = ParseResult.ArrayFormatter.formatErrorSync(err);
  return formatted.map((i) => ({
    path: i.path as (string | number)[],
    message: sanitizeValidationMessage(
      i.path.map(String).join("."),
      i.message,
    ),
  }));
}

function makeValidationError(
  issues: readonly EffectIssue[],
): EffectValidationError {
  return {
    name: "ParseError",
    issues,
    flatten() {
      const formErrors: string[] = [];
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of issues) {
        if (issue.path.length === 0) {
          formErrors.push(issue.message);
          continue;
        }
        const key = String(issue.path[0]);
        const list = fieldErrors[key] ?? [];
        list.push(issue.message);
        fieldErrors[key] = list;
      }
      return {
        formErrors,
        fieldErrors: sanitizeFieldErrors(fieldErrors),
      };
    },
  };
}

/** Decode unknown input with Effect Schema into a safeParse-shaped result. */
export function decodeToValidationResult<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): EffectValidationResult<A> {
  const decoded = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(decoded)) {
    return { success: true, data: decoded.right };
  }
  return {
    success: false,
    error: makeValidationError(issuesFromParseError(decoded.left)),
  };
}

/** Sync parse helper (throws on failure). */
export function parseSchema<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): A {
  return Schema.decodeUnknownSync(schema)(input);
}

/** Sync safeParse helper for tests and imperative callers. */
export function safeParseSchema<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): EffectValidationResult<A> {
  return decodeToValidationResult(schema, input);
}

type HookResult = Response | void | undefined | Promise<Response | void | undefined>;

/**
 * Hono middleware: validate json/query/param/header/form via Effect Schema.
 * Types `c.req.valid(target)` as schema output type A.
 */
export function sValidator<
  Target extends keyof ValidationTargets,
  A,
  I,
  E extends Env = Env,
  P extends string = string,
>(
  target: Target,
  schema: Schema.Schema<A, I, never>,
  hook?: (
    result: EffectValidationResult<A>,
    c: Context<E, P>,
  ) => HookResult,
): MiddlewareHandler<
  E,
  P,
  // Hono Input for validated target
  { in: { [K in Target]: A }; out: { [K in Target]: A } }
> {
  type V = { in: { [K in Target]: A }; out: { [K in Target]: A } };

  const mw = validator(target, async (value, c) => {
    const result = decodeToValidationResult(schema, value);

    if (hook) {
      const hookResponse = await hook(
        result,
        c as Context<E, P>,
      );
      if (hookResponse instanceof Response) {
        return hookResponse;
      }
    }

    if (!result.success) {
      return c.json(
        {
          success: false as const,
          error: {
            name: "ParseError" as const,
            issues: result.error.issues.map((issue) => ({
              path: [...issue.path],
              message: issue.message,
            })),
          },
        },
        400,
      );
    }

    return result.data;
  });

  return mw as unknown as MiddlewareHandler<E, P, V & Input>;
}
