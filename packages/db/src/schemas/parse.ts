/**
 * Effect Schema decode helpers with safeParse-shaped results for tests and
 * imperative call sites. Production path is Effect Schema only.
 */
import { Either, ParseResult, Schema } from "effect";

export type ParseIssue = {
  readonly path: (string | number)[];
  readonly message: string;
};

export type SafeParseSuccess<A> = {
  readonly success: true;
  readonly data: A;
};

export type SafeParseFailure = {
  readonly success: false;
  readonly error: {
    readonly name: "ParseError";
    readonly issues: readonly ParseIssue[];
    flatten(): {
      formErrors: string[];
      fieldErrors: Record<string, string[] | undefined>;
    };
  };
};

export type SafeParseResult<A> = SafeParseSuccess<A> | SafeParseFailure;

function toIssues(err: ParseResult.ParseError): ParseIssue[] {
  return ParseResult.ArrayFormatter.formatErrorSync(err).map((i) => ({
    path: i.path as (string | number)[],
    message: i.message,
  }));
}

function makeError(issues: readonly ParseIssue[]): SafeParseFailure["error"] {
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
      return { formErrors, fieldErrors };
    },
  };
}

/** Decode or throw (Effect Schema decodeUnknownSync). */
export function parse<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): A {
  return Schema.decodeUnknownSync(schema)(input);
}

/** Decode to safeParse result for tests/imperative callers. */
export function safeParse<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): SafeParseResult<A> {
  const result = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(result)) {
    return { success: true, data: result.right };
  }
  return { success: false, error: makeError(toIssues(result.left)) };
}

/**
 * Attach `.parse` / `.safeParse` methods onto an Effect Schema for
 * tests and imperative call sites.
 */
export function withParseApi<A, I, R = never>(
  schema: Schema.Schema<A, I, R>,
): Schema.Schema<A, I, R> & {
  parse(input: unknown): A;
  safeParse(input: unknown): SafeParseResult<A>;
} {
  const s = schema as Schema.Schema<A, I, never>;
  const wrapped = schema as Schema.Schema<A, I, R> & {
    parse(input: unknown): A;
    safeParse(input: unknown): SafeParseResult<A>;
  };
  wrapped.parse = (input: unknown) => parse(s, input);
  wrapped.safeParse = (input: unknown) => safeParse(s, input);
  return wrapped;
}
