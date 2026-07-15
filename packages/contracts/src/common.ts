import { z } from "zod";

/**
 * Shared leaf validation schemas used by more than one runtime.
 * Prefer leaf schemas over one giant FIELD_LIMITS object.
 */

/** ISO 4217 currency code (3 uppercase letters). */
export const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .transform((c) => c.toUpperCase());

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** Non-negative integer minor units (cents, etc.). */
export const moneyMinorSchema = z.number().int().nonnegative();

export const moneySchema = z.object({
  amountMinor: moneyMinorSchema,
  currency: currencyCodeSchema,
});

export type Money = z.infer<typeof moneySchema>;
