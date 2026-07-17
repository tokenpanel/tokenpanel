/**
 * Typed date-range + page helpers for domain read operations (task 8.6).
 */
import {
  PAGINATION_DEFAULT_LIMIT_COUNT,
  PAGINATION_MAX_LIMIT_COUNT,
} from "./policy.ts";
import type { DateRange, PageQuery } from "../ports/common.ts";
import { ValidationError } from "../../errors/families.ts";
import { Effect } from "effect";

export type RawPageInput = {
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
};

/**
 * Clamp / default pagination. Returns ValidationError when values are not finite.
 */
export function normalizePageQuery(
  input: RawPageInput = {},
): Effect.Effect<PageQuery, ValidationError> {
  return Effect.gen(function* () {
    const limitRaw = input.limit ?? PAGINATION_DEFAULT_LIMIT_COUNT;
    const skipRaw = input.skip ?? 0;
    if (!Number.isFinite(limitRaw) || !Number.isFinite(skipRaw)) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: "Invalid pagination parameters",
          mode: "default_400",
        }),
      );
    }
    const limit = Math.min(
      PAGINATION_MAX_LIMIT_COUNT,
      Math.max(1, Math.trunc(limitRaw)),
    );
    const skip = Math.max(0, Math.trunc(skipRaw));
    return { limit, skip };
  });
}

export type RawDateRangeInput = {
  readonly from: string;
  readonly to: string;
};

/**
 * Parse inclusive date range. Date-only `to` (≤10 chars) becomes end-of-UTC-day.
 */
export function parseDateRange(
  input: RawDateRangeInput,
): Effect.Effect<DateRange, ValidationError> {
  return Effect.gen(function* () {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: "Invalid date range",
          mode: "default_400",
          details: { from: ["invalid"], to: ["invalid"] },
        }),
      );
    }
    if (input.to.length <= 10) {
      to.setUTCHours(23, 59, 59, 999);
    }
    if (from.getTime() > to.getTime()) {
      return yield* Effect.fail(
        new ValidationError({
          code: "validation_error",
          message: "from must be ≤ to",
          mode: "default_400",
        }),
      );
    }
    return { from, to };
  });
}
