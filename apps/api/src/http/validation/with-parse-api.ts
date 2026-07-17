/**
 * Attach .parse / .safeParse to Effect Schema for route unit tests.
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
        flatten(): {
          formErrors: string[];
          fieldErrors: Record<string, string[] | undefined>;
        };
      };
    };

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
  wrapped.parse = (input: unknown) => Schema.decodeUnknownSync(schema)(input);
  wrapped.safeParse = (input: unknown): SafeParseResult<A> => {
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
    return {
      success: false,
      error: {
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
      },
    };
  };
  return wrapped;
}
