/**
 * Effect Schema parse helpers for contracts package tests / callers.
 */
import { Either, ParseResult, Schema } from "effect";

export type SafeParseResult<A> =
  | { readonly success: true; readonly data: A }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: readonly {
          readonly path: (string | number)[];
          readonly message: string;
        }[];
      };
    };

export function parse<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): A {
  return Schema.decodeUnknownSync(schema)(input);
}

export function safeParse<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): SafeParseResult<A> {
  const result = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(result)) {
    return { success: true, data: result.right };
  }
  const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left).map(
    (i) => ({
      path: i.path as (string | number)[],
      message: i.message,
    }),
  );
  return { success: false, error: { issues } };
}

export function withParseApi<A, I>(
  schema: Schema.Schema<A, I, never>,
): Schema.Schema<A, I, never> & {
  parse(input: unknown): A;
  safeParse(input: unknown): SafeParseResult<A>;
} {
  const wrapped = schema as Schema.Schema<A, I, never> & {
    parse(input: unknown): A;
    safeParse(input: unknown): SafeParseResult<A>;
  };
  wrapped.parse = (input: unknown) => parse(schema, input);
  wrapped.safeParse = (input: unknown) => safeParse(schema, input);
  return wrapped;
}
