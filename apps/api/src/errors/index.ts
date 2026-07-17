/**
 * Canonical error taxonomy + classification + boundary helpers.
 *
 * Routes / domain services (later):
 *   import { NotFoundError, classifyMongoError, toHttpResponse } from "../errors/index.ts"
 *   import { renderAdminError, renderOpenAIError } from "../http/renderers/index.ts"
 */

export { ErrorCodes, type ErrorCode } from "./codes.ts";
export {
  APP_ERROR_TAGS,
  AuthenticationError,
  AuthorizationError,
  BudgetExceededError,
  ConfigurationError,
  ConflictError,
  InsufficientBalanceError,
  InvalidStateError,
  NotFoundError,
  PersistenceConflictError,
  PersistenceDataError,
  PersistenceDuplicateKeyError,
  PersistenceTimeoutError,
  PersistenceUnavailableError,
  ProviderProtocolError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  RateLimitExceededError,
  SystemError,
  ValidationError,
  appErrorCode,
  appErrorTag,
  isAppError,
  isPersistenceAppError,
  isProviderAppError,
  type AppError,
  type AppErrorTag,
  type PersistenceAppError,
  type ProviderAppError,
  type ValidationIssue,
} from "./families.ts";
export {
  PROVIDER_CATEGORIES,
  PROVIDER_PHASES,
  PROTOCOL_CATEGORIES,
  REJECTED_CATEGORIES,
  TIMEOUT_CATEGORIES,
  UNAVAILABLE_CATEGORIES,
  acceptanceClassOf,
  fallbackClassOf,
  retryClassOf,
  streamCommitClassOf,
  type AcceptanceClass,
  type FallbackClass,
  type HttpSurface,
  type ProviderErrorCategory,
  type ProviderErrorPhase,
  type RetryClass,
  type StreamCommitClass,
  type ValidationMode,
} from "./variants.ts";
export { classifyMongoError } from "./classify-mongo.ts";
export {
  classifyProviderError,
  isFallbackAllowedForError,
  providerErrorFromCategory,
  type ClassifyProviderOptions,
} from "./classify-provider.ts";
export {
  SAFE_MESSAGES,
  classifyJwtMessage,
  looksLikeUnsafeDiagnostic,
  publicMessageForCode,
  type SafeMessageKey,
} from "./safe-messages.ts";
export {
  ERROR_POLICIES,
  policyFor,
  type ErrorPolicy,
  type PublicVisibility,
} from "./policy.ts";
export {
  newCorrelationIds,
  newRequestId,
  newTraceId,
  logFieldsForAppError,
  logFieldsForDefect,
  logFieldsForInterruption,
  privateDiagnosticOf,
  redactHeaders,
  redactString,
  redactUnknown,
  redactUri,
  type CorrelationIds,
  type LogLevel,
  type StructuredLogFields,
} from "./observability.ts";
export {
  toHttpResponse,
  renderAppError,
  renderUnknownThrow,
  type ToHttpResponseOptions,
} from "./boundary.ts";
