/**
 * Shared Effect Schema decode helpers for tests and future Hono adapters.
 */
import { Either, ParseResult, Schema } from "effect";

export type DecodeOk<A> = { readonly success: true; readonly data: A };
export type DecodeErr = {
  readonly success: false;
  readonly paths: readonly string[];
  readonly messages: readonly string[];
  readonly issues: readonly ParseResult.ArrayFormatterIssue[];
};

export type DecodeResult<A> = DecodeOk<A> | DecodeErr;

export function decodeUnknownEither<A, I>(
  schema: Schema.Schema<A, I, never>,
  input: unknown,
): DecodeResult<A> {
  const result = Schema.decodeUnknownEither(schema)(input);
  if (Either.isRight(result)) {
    return { success: true, data: result.right };
  }
  const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
  return {
    success: false,
    paths: issues.map((i) => i.path.join(".")),
    messages: issues.map((i) => i.message),
    issues,
  };
}

export function encodeEither<A, I>(
  schema: Schema.Schema<A, I, never>,
  value: A,
): DecodeResult<I> {
  const result = Schema.encodeEither(schema)(value);
  if (Either.isRight(result)) {
    return { success: true, data: result.right };
  }
  const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
  return {
    success: false,
    paths: issues.map((i) => i.path.join(".")),
    messages: issues.map((i) => i.message),
    issues,
  };
}
