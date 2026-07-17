/**
 * Protocol error renderers — import from here in Hono adapters / routes.
 */

export {
  renderAdminError,
  renderAdminDefect,
  renderAdminMessage,
} from "./admin.ts";
export {
  renderManagementError,
  renderManagementDefect,
} from "./management.ts";
export {
  formatOpenAIErrorBody,
  renderOpenAIError,
  renderOpenAIDefect,
  openAISseTerminalError,
  openAISseTerminalFromAppError,
  OPENAI_SSE_DONE,
} from "./openai.ts";
export {
  formatAnthropicErrorBody,
  anthropicTypeFromBillingCode,
  renderAnthropicError,
  renderAnthropicDefect,
  anthropicSseTerminalError,
  anthropicSseTerminalFromAppError,
} from "./anthropic.ts";
export {
  sanitizeValidationMessage,
  sanitizeFieldErrors,
  sanitizeIssues,
  validationError400,
  validationError422,
  renderValidationError,
  statusForValidationMode,
} from "./validation.ts";
export type { RenderedHttpError, BoundaryOutcome, HttpSurface } from "./types.ts";
export { emptyHeaders, withRetryAfter } from "./types.ts";
