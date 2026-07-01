import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * Shared zod primitives for MongoDB documents.
 * Stored documents use real ObjectId + Date instances; input variants coerce.
 */

export const objectId = z.instanceof(ObjectId);

/** Parse a string into an ObjectId, throwing on invalid input. */
export const objectIdFromString = z
  .string()
  .transform((value, ctx): ObjectId => {
    if (!ObjectId.isValid(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid ObjectId: ${value}`,
      });
      return z.NEVER;
    }
    return new ObjectId(value);
  });

/** Stored timestamps are Date instances. */
export const timestampFields = {
  createdAt: z.instanceof(Date),
  updatedAt: z.instanceof(Date),
};

/** ISO currency code. Lowercased in storage, validated here. */
export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .transform((c) => c.toUpperCase());

/** Non-negative decimal money amount stored as integer minor units (cents). */
export const moneyMinor = z.number().int().nonnegative();

/** A 2-tuple price expressed in minor units + currency. */
export const money = z.object({
  amountMinor: moneyMinor,
  currency: currencyCode,
});

export type Money = z.infer<typeof money>;

/**
 * Per-token price schedule. All values are integer minor units PER MILLION
 * tokens, in the model's currency. Mirrors the models.dev cost schema
 * (input/output/reasoning/cache_read/cache_write/audio).
 *
 * Example: $3.00 per 1M input tokens → inputMinorPerMillion = 300.
 */
export const tokenPriceSchedule = z.object({
  inputMinorPerMillion: moneyMinor,
  outputMinorPerMillion: moneyMinor,
  reasoningMinorPerMillion: moneyMinor.optional(),
  cacheReadMinorPerMillion: moneyMinor.optional(),
  cacheWriteMinorPerMillion: moneyMinor.optional(),
  inputAudioMinorPerMillion: moneyMinor.optional(),
  outputAudioMinorPerMillion: moneyMinor.optional(),
});

export type TokenPriceSchedule = z.infer<typeof tokenPriceSchedule>;

/** Input/output token limits (context window). */
export const tokenLimits = z.object({
  context: z.number().int().positive(),
  input: z.number().int().positive().optional(),
  output: z.number().int().positive().optional(),
});

export type TokenLimits = z.infer<typeof tokenLimits>;

/** Supported modalities per models.dev. */
export const modalitySchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "pdf",
]);

export const modalities = z.object({
  input: z.array(modalitySchema),
  output: z.array(modalitySchema),
});

export type Modalities = z.infer<typeof modalities>;

/** Model lifecycle status. */
export const modelStatus = z.enum(["alpha", "beta", "deprecated", "ga"]);
export type ModelStatus = z.infer<typeof modelStatus>;

/**
 * Interleaved reasoning config: the response field that carries reasoning
 * tokens inline ("reasoning_content" for some providers, "reasoning_details"
 * for others).
 */
export const interleaved = z.object({
  field: z.enum(["reasoning_content", "reasoning_details"]),
});

export type Interleaved = z.infer<typeof interleaved>;

/**
 * Reusable block of provider-agnostic model capabilities (from models.dev).
 * Shared between the model catalog and per-provider entries.
 */
export const modelCapabilities = z.object({
  reasoning: z.boolean().default(false),
  toolCall: z.boolean().default(false),
  structuredOutput: z.boolean().optional(),
  temperature: z.boolean().optional(),
  attachment: z.boolean().default(false),
  interleaved: interleaved.nullish(),
});

export type ModelCapabilities = z.infer<typeof modelCapabilities>;