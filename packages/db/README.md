# `@ai-chat-eval/db`

PostgreSQL persistence for reproducible Prompt experiments. Drizzle owns the schema; `postgres-js`
owns the connection pool. Importing the package has no side effects—applications explicitly call
`createDatabaseClient()` and close it during shutdown.

Version tables are append-only for evaluation content. Repositories expose creation plus lifecycle
transitions, but no API that mutates Prompt blocks or framework definitions. Publication only changes
the lifecycle columns. Content hashes use canonical JSON, and Prompt source maps preserve the exact
block offsets needed by attribution views.

Diagnosis runs preserve the submitted canonical bundle and lifecycle state. Successful terminal
records hold the independently versioned report plus its report/input hashes; failed records retain
only a bounded public failure code and message. Conditional transitions prevent a terminal record
from being overwritten by a retry racing with the original request.

Generate and apply migrations from the repository root:

```sh
pnpm db:generate
pnpm db:check
pnpm db:migrate
```

Required configuration is `DATABASE_URL`. Pool, timeout, and TLS overrides are documented by the
exported `loadDatabaseConfig()` function and default safely for local development.
