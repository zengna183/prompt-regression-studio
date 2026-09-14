import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { loadDatabaseConfig, type DatabaseConfig } from "./config.js";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;
export type PostgresSql = ReturnType<typeof postgres>;

export interface DatabaseClient {
  readonly db: Database;
  readonly sql: PostgresSql;
  close: () => Promise<void>;
}

/** Creates an explicit, independently closable pool. Importing this package never opens a connection. */
export function createDatabaseClient(
  config: DatabaseConfig = loadDatabaseConfig(),
): DatabaseClient {
  const sql = postgres(config.url, {
    max: config.poolMax,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    ssl: config.ssl ? "require" : false,
  });
  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => sql.end({ timeout: 5 }),
  };
}
