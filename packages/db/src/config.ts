/**
 * Explicit library configuration for @tokenpanel/db.
 * Application executables (API, migrator CLI) parse their own env and call
 * configureDb before getDb(). The library does not discover application env.
 */

export type MongoConnectionConfig = Readonly<{
  uri: string;
  databaseName: string;
}>;

/** Private client policy: how long to wait for server selection on connect. */
export const DB_CLIENT_SERVER_SELECTION_TIMEOUT_MS = 5000;

let configured: MongoConnectionConfig | null = null;
let connected = false;

export function configureDb(config: MongoConnectionConfig): void {
  if (connected) {
    throw new Error(
      "configureDb refused: MongoDB connection already established. closeDb() first.",
    );
  }
  if (!config.uri || config.uri.trim().length === 0) {
    throw new Error("configureDb: uri is required");
  }
  if (!config.databaseName || config.databaseName.length === 0) {
    throw new Error("configureDb: databaseName is required");
  }
  configured = Object.freeze({
    uri: config.uri,
    databaseName: config.databaseName,
  });
}

export function getMongoConnectionConfig(): MongoConnectionConfig {
  if (!configured) {
    throw new Error(
      "MongoDB not configured. Call configureDb({ uri, databaseName }) before getDb().",
    );
  }
  return configured;
}

export function isDbConfigured(): boolean {
  return configured !== null;
}

/** Internal: mark connection open so reconfigure is rejected. */
export function markDbConnected(): void {
  connected = true;
}

/** Internal: reset connection flag (after close). Keeps config unless cleared. */
export function markDbDisconnected(): void {
  connected = false;
}

/** Clear configuration (tests). Refused while connected. */
export function clearDbConfig(): void {
  if (connected) {
    throw new Error("clearDbConfig refused while connected; closeDb() first");
  }
  configured = null;
}
