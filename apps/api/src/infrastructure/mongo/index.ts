/**
 * Mongo infrastructure: validated repositories + session helpers.
 */
export {
  decodeDocument,
  decodeDocuments,
  decodeOptionalDocument,
  decodeWriteInput,
  persistenceDataError,
} from "./decode.ts";

export {
  parseObjectId,
  parseObjectIdStrict,
  requireFound,
  normalizePage,
  buildSort,
  safeEqualityFilter,
  textSearchFilter,
  escapeRegExp,
  buildProjection,
  type PageParams,
  type NormalizedPage,
  type PageResult,
  type SortDirection,
  type ProjectionSpec,
} from "./helpers.ts";

export { tryMongo, type MongoFailure, type SessionOption } from "./try-mongo.ts";

export {
  withMongoSession,
  abortSession,
  type WithSessionOptions,
} from "./session.ts";

export * from "./repositories/index.ts";
