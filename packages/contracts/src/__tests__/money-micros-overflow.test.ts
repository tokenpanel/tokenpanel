import { test, expect, describe } from "bun:test";
import {
  parseMajorToMicros,
  formatMicrosToMajor,
  moneyMicrosSchema,
  MICROS_PER_MAJOR,
} from "../money-micros.ts";

const MAX_SAFE_MICROS = Number.MAX_SAFE_INTEGER;

describe("parseMajorToMicros: safe-integer overflow", () => {
  test("value at MAX_SAFE_INTEGER micros is accepted", () => {
    // Largest representable amount: floor(MAX / 1e6) majors + .740991
    // (since MAX % 1e6 === 740991) lands exactly on MAX_SAFE_INTEGER.
    const intPart = Math.floor(MAX_SAFE_MICROS / MICROS_PER_MAJOR);
    const frac = MAX_SAFE_MICROS % MICROS_PER_MAJOR;
    const fracStr = String(frac).padStart(6, "0");
    expect(parseMajorToMicros(`${intPart}.${fracStr}`)).toBe(MAX_SAFE_MICROS);
  });

  test("one micro past the maximum is rejected", () => {
    const intPart = Math.floor(MAX_SAFE_MICROS / MICROS_PER_MAJOR);
    const frac = (MAX_SAFE_MICROS % MICROS_PER_MAJOR) + 1;
    expect(() =>
      parseMajorToMicros(`${intPart}.${String(frac).padStart(6, "0")}`),
    ).toThrow(/exceeds safe integer/);
  });

  test("huge whole units rejected, not silently rounded", () => {
    // 10^16 majors would be 10^22 micros — far beyond 2^53.
    expect(() => parseMajorToMicros("10000000000000000")).toThrow(
      /exceeds safe integer/,
    );
  });

  test("negative overflow rejected too when negatives allowed", () => {
    expect(() =>
      parseMajorToMicros("-10000000000000000", { allowNegative: true }),
    ).toThrow(/exceeds safe integer/);
  });

  test("boundary: just under the limit with a fraction stays exact", () => {
    // floor(MAX/1e6) majors + .000001 is MAX - 740990, still safe.
    const intPart = Math.floor(MAX_SAFE_MICROS / MICROS_PER_MAJOR);
    expect(parseMajorToMicros(`${intPart}.000001`)).toBe(
      MAX_SAFE_MICROS - 740_990,
    );
  });
});

describe("formatMicrosToMajor: non-safe-integer guard", () => {
  test("throws on non-safe-integer micros", () => {
    expect(() => formatMicrosToMajor(MAX_SAFE_MICROS + 1)).toThrow(
      /non-safe-integer micros/,
    );
    expect(() => formatMicrosToMajor(Number.MAX_VALUE)).toThrow(
      /non-safe-integer micros/,
    );
    expect(() => formatMicrosToMajor(1.5)).toThrow(/non-safe-integer micros/);
  });

  test("boundary MAX_SAFE_INTEGER itself formats exactly", () => {
    const whole = Math.floor(MAX_SAFE_MICROS / MICROS_PER_MAJOR);
    const frac = MAX_SAFE_MICROS % MICROS_PER_MAJOR;
    const expected =
      frac === 0
        ? `${whole}`
        : `${whole}.${String(frac).padStart(6, "0").replace(/0+$/, "")}`;
    expect(formatMicrosToMajor(MAX_SAFE_MICROS)).toBe(expected);
  });
});

describe("moneyMicrosSchema: overflow boundary", () => {
  test("accepts MAX_SAFE_INTEGER, rejects one past it", () => {
    expect(moneyMicrosSchema.safeParse(MAX_SAFE_MICROS).success).toBe(true);
    expect(moneyMicrosSchema.safeParse(MAX_SAFE_MICROS + 1).success).toBe(false);
  });
});
