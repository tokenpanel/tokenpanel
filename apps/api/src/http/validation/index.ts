/**
 * API-local Effect Schema wire validation (production path).
 *
 *   import { LoginBody, SignupBody } from "../http/validation/index.ts"
 *   import { OpenAIChatCompletionBody } from "../http/validation/protocol.ts"
 *
 * Domain create/update mirrors also live in `@tokenpanel/db/schemas/effect`.
 */
export * from "./identity.ts";
export * from "./query.ts";
export * from "./protocol.ts";
export {
  sValidator,
  parseSchema,
  safeParseSchema,
  decodeToValidationResult,
} from "./validator.ts";
export type {
  EffectValidationResult,
  EffectValidationError,
  ValidationTarget,
} from "./validator.ts";
