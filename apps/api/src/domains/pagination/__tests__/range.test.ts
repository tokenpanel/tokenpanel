/**
 * Pagination domain helpers: normalizePageQuery clamp/validation + parseDateRange.
 * Pure Effects — no repos, no DB.
 */
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ValidationError } from "../../../errors/families.ts";
import { normalizePageQuery, parseDateRange } from "../range.ts";

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

function runFail<E extends Error>(effect: Effect.Effect<unknown, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(effect) as Effect.Effect<E, never>);
}

describe("normalizePageQuery", () => {
  test("defaults: limit 50, skip 0", async () => {
    expect(await run(normalizePageQuery())).toEqual({ limit: 50, skip: 0 });
  });

  test("passes through in-range values", async () => {
    expect(await run(normalizePageQuery({ limit: 25, skip: 100 }))).toEqual({
      limit: 25,
      skip: 100,
    });
  });

  test("clamps limit above max to 500", async () => {
    expect(await run(normalizePageQuery({ limit: 5000 }))).toEqual({
      limit: 500,
      skip: 0,
    });
  });

  test("clamps limit below 1 to 1", async () => {
    expect(await run(normalizePageQuery({ limit: 0 }))).toEqual({
      limit: 1,
      skip: 0,
    });
    expect(await run(normalizePageQuery({ limit: -10 }))).toEqual({
      limit: 1,
      skip: 0,
    });
  });

  test("clamps negative skip to 0", async () => {
    expect(await run(normalizePageQuery({ skip: -5 }))).toEqual({
      limit: 50,
      skip: 0,
    });
  });

  test("truncates fractional inputs", async () => {
    expect(await run(normalizePageQuery({ limit: 10.9, skip: 3.2 }))).toEqual({
      limit: 10,
      skip: 3,
    });
  });

  test("fails ValidationError on non-finite limit/skip", async () => {
    const err = await runFail(
      normalizePageQuery({ limit: Number.NaN }) as Effect.Effect<
        unknown,
        ValidationError
      >,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("validation_error");

    const skipErr = await runFail(
      normalizePageQuery({ skip: Number.POSITIVE_INFINITY }) as Effect.Effect<
        unknown,
        ValidationError
      >,
    );
    expect(skipErr).toBeInstanceOf(ValidationError);
  });
});

describe("parseDateRange", () => {
  test("parses full ISO timestamps inclusively", async () => {
    const range = await run(
      parseDateRange({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-31T12:00:00.000Z",
      }),
    );
    expect(range.from.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-01-31T12:00:00.000Z");
  });

  test("date-only `to` becomes end of UTC day", async () => {
    const range = await run(
      parseDateRange({ from: "2026-03-01", to: "2026-03-01" }),
    );
    expect(range.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-03-01T23:59:59.999Z");
  });

  test("longer `to` values are not end-of-day adjusted", async () => {
    const range = await run(
      parseDateRange({
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-02T00:00:00.000Z",
      }),
    );
    expect(range.to.toISOString()).toBe("2026-03-02T00:00:00.000Z");
  });

  test("fails ValidationError on unparseable from/to", async () => {
    const err = await runFail(
      parseDateRange({ from: "not-a-date", to: "2026-01-01" }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe("validation_error");
  });

  test("fails ValidationError when from is after to", async () => {
    const err = await runFail(
      parseDateRange({ from: "2026-02-01", to: "2026-01-01" }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("from must be ≤ to");
  });
});
