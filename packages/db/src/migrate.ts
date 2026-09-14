import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabaseClient } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const client = createDatabaseClient();

try {
  await migrate(client.db, { migrationsFolder });
} finally {
  await client.close();
}
