import type {
  AggregateOptions,
  AggregationCursor,
  AnyBulkWriteOperation,
  BulkWriteOptions,
  BulkWriteResult,
  ClientSession,
  Collection,
  CommandOperationOptions,
  CountDocumentsOptions,
  CreateIndexesOptions,
  Db,
  DeleteOptions,
  DeleteResult,
  DistinctOptions,
  Document,
  DropCollectionOptions,
  DropIndexesOptions,
  EstimatedDocumentCountOptions,
  Filter,
  FindCursor,
  FindOneAndDeleteOptions,
  FindOneAndReplaceOptions,
  FindOneAndUpdateOptions,
  FindOptions,
  IndexDescription,
  InsertManyResult,
  InsertOneOptions,
  InsertOneResult,
  ModifyResult,
  OptionalUnlessRequiredId,
  RenameOptions,
  ReplaceOptions,
  UpdateFilter,
  UpdateOptions,
  UpdateResult,
  WithId,
  WithoutId,
} from "mongodb";

/**
 * A Collection whose every operation is bound to a {@link ClientSession}.
 *
 * Migrations receive {@link MigrationDb} (not a raw `Db`) so session binding is
 * structural — there is no path that lets a migration forget `{ session }`.
 * Without this, writes inside `session.withTransaction()` but without
 * `{ session }` autocommit outside the txn: a throwing migration would leave
 * data mutated while the `_migrations` record rolls back, causing silent
 * double-applies on retry. This wrapper makes that foot-gun impossible.
 */
export interface SessionBoundCollection<TSchema extends Document = Document> {
  insertOne(doc: OptionalUnlessRequiredId<TSchema>, options?: Omit<InsertOneOptions, "session">): Promise<InsertOneResult<TSchema>>;
  insertMany(docs: OptionalUnlessRequiredId<TSchema>[], options?: Omit<BulkWriteOptions, "session">): Promise<InsertManyResult<TSchema>>;
  updateOne(filter: Filter<TSchema>, update: UpdateFilter<TSchema> | Document[], options?: Omit<UpdateOptions, "session">): Promise<UpdateResult>;
  updateMany(filter: Filter<TSchema>, update: UpdateFilter<TSchema> | Document[], options?: Omit<UpdateOptions, "session">): Promise<UpdateResult>;
  replaceOne(filter: Filter<TSchema>, replacement: WithoutId<TSchema>, options?: Omit<ReplaceOptions, "session">): Promise<UpdateResult>;
  deleteOne(filter: Filter<TSchema>, options?: Omit<DeleteOptions, "session">): Promise<DeleteResult>;
  deleteMany(filter: Filter<TSchema>, options?: Omit<DeleteOptions, "session">): Promise<DeleteResult>;
  findOneAndUpdate(filter: Filter<TSchema>, update: UpdateFilter<TSchema> | Document[], options?: Omit<FindOneAndUpdateOptions, "session">): Promise<WithId<TSchema> | ModifyResult<TSchema> | null>;
  findOneAndReplace(filter: Filter<TSchema>, replacement: WithoutId<TSchema>, options?: Omit<FindOneAndReplaceOptions, "session">): Promise<WithId<TSchema> | ModifyResult<TSchema> | null>;
  findOneAndDelete(filter: Filter<TSchema>, options?: Omit<FindOneAndDeleteOptions, "session">): Promise<WithId<TSchema> | ModifyResult<TSchema> | null>;
  bulkWrite(operations: AnyBulkWriteOperation<TSchema>[], options?: Omit<BulkWriteOptions, "session">): Promise<BulkWriteResult>;
  createIndex(indexSpec: Document, options?: Omit<CreateIndexesOptions, "session">): Promise<string>;
  createIndexes(indexSpecs: IndexDescription[], options?: Omit<CreateIndexesOptions, "session">): Promise<string[]>;
  dropIndex(indexName: string, options?: Omit<DropIndexesOptions, "session">): Promise<Document>;
  dropIndexes(options?: Omit<DropIndexesOptions, "session">): Promise<boolean>;
  rename(newName: string, options?: Omit<RenameOptions, "session">): Promise<Collection<Document>>;
  drop(options?: Omit<DropCollectionOptions, "session">): Promise<boolean>;
  findOne(filter?: Filter<TSchema>, options?: Omit<FindOptions<TSchema>, "session">): Promise<WithId<TSchema> | null>;
  find(filter?: Filter<TSchema>, options?: Omit<FindOptions<TSchema>, "session">): FindCursor<WithId<TSchema>>;
  countDocuments(filter?: Filter<TSchema>, options?: Omit<CountDocumentsOptions, "session">): Promise<number>;
  estimatedDocumentCount(options?: Omit<EstimatedDocumentCountOptions, "session">): Promise<number>;
  aggregate<T extends Document = Document>(pipeline: Document[], options?: Omit<AggregateOptions, "session">): AggregationCursor<T>;
  distinct(key: string, filter?: Filter<TSchema>, options?: Omit<DistinctOptions, "session">): Promise<unknown[]>;
}

/**
 * A session-bound view of a database, exposed to migrations. Every collection
 * access returns a {@link SessionBoundCollection}; `command()` likewise binds
 * the session. Migrations never receive the raw `Db`, so they cannot perform
 * un-sessioned operations.
 */
export interface MigrationDb {
  collection<TSchema extends Document = Document>(name: string): SessionBoundCollection<TSchema>;
  command(command: Document, options?: Omit<CommandOperationOptions, "session">): Promise<Document>;
}

/**
 * Build a {@link MigrationDb} over `db` whose every operation is bound to
 * `session`. Used by the migration runner so migrations structurally cannot
 * forget to pass `{ session }`.
 */
export function createMigrationDb(db: Db, session: ClientSession): MigrationDb {
  return {
    collection<TSchema extends Document = Document>(name: string): SessionBoundCollection<TSchema> {
      const coll = db.collection<TSchema>(name);
      return {
        insertOne: (doc, options) => coll.insertOne(doc, { ...options, session }),
        insertMany: (docs, options) => coll.insertMany(docs, { ...options, session }),
        updateOne: (filter, update, options) => coll.updateOne(filter, update, { ...options, session }),
        updateMany: (filter, update, options) => coll.updateMany(filter, update, { ...options, session }),
        replaceOne: (filter, replacement, options) => coll.replaceOne(filter, replacement, { ...options, session }),
        deleteOne: (filter, options) => coll.deleteOne(filter, { ...options, session }),
        deleteMany: (filter, options) => coll.deleteMany(filter, { ...options, session }),
        findOneAndUpdate: (filter, update, options) => coll.findOneAndUpdate(filter, update, { ...options, session }),
        findOneAndReplace: (filter, replacement, options) => coll.findOneAndReplace(filter, replacement, { ...options, session }),
        findOneAndDelete: (filter, options) => coll.findOneAndDelete(filter, { ...options, session }),
        bulkWrite: (operations, options) => coll.bulkWrite(operations, { ...options, session }),
        createIndex: (indexSpec, options) => coll.createIndex(indexSpec, { ...options, session }),
        createIndexes: (indexSpecs, options) => coll.createIndexes(indexSpecs, { ...options, session }),
        dropIndex: (indexName, options) => coll.dropIndex(indexName, { ...options, session }),
        dropIndexes: (options) => coll.dropIndexes({ ...options, session }),
        rename: (newName, options) => coll.rename(newName, { ...options, session }),
        drop: (options) => coll.drop({ ...options, session }),
        findOne: (filter, options) => coll.findOne(filter ?? {}, { ...options, session }),
        find: (filter, options) => coll.find(filter ?? {}, { ...options, session }),
        countDocuments: (filter, options) => coll.countDocuments(filter, { ...options, session }),
        estimatedDocumentCount: (options) => coll.estimatedDocumentCount({ ...options, session }),
        aggregate: (pipeline, options) => coll.aggregate(pipeline, { ...options, session }),
        distinct: (key, filter, options) => coll.distinct(key, filter ?? {}, { ...options, session }),
      };
    },
    command: (command, options) => db.command(command, { ...options, session }),
  };
}
