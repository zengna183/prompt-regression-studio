# Contributing

Thank you for helping build Prompt Regression Studio. The project values reproducibility, inspectable evidence, and honest failure states over impressive-looking demo results.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Security vulnerabilities must follow [SECURITY.md](./SECURITY.md), not the public issue tracker.

## Before opening code

For a bug, open an issue with:

- the smallest reproducible example;
- expected and actual behavior;
- operating system, Node.js/pnpm versions, database version, and relevant logs with secrets removed;
- whether data integrity or a published evaluation result may be affected.

For a material design change, start with a proposal describing:

- the user problem and why current behavior is insufficient;
- the data and API compatibility impact;
- alternatives considered;
- failure, security, privacy, cost, and rollback behavior;
- how the result will be tested and observed.

Please do not begin a broad rewrite or add a new infrastructure dependency without agreement on that proposal.

## Development setup

The diagnosis Core requires Python 3.12+. The retained Web/API/Worker foundation additionally requires Node.js 22+, pnpm 11, Docker, and Docker Compose.

Run the Core without installing any third-party Python package:

```bash
export PYTHONPATH="packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python scripts/run-python-tests.py
```

On Windows PowerShell, use `$env:PYTHONPATH = "packages/python/core/src"` instead of `export`.

For the TypeScript foundation and local services:

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

On Windows PowerShell, replace the first command with:

```powershell
Copy-Item .env.example .env
```

Before submitting a pull request:

```bash
python scripts/run-python-tests.py
pnpm contracts:check
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke:diagnosis-api
```

Never commit `.env`, provider keys, production prompts/responses, customer data, database dumps, or logs containing sensitive payloads.

## Architecture rules

Changes should preserve these invariants:

1. Published Prompt, dataset, framework, and evaluator versions are immutable. Editing creates a new version.
2. Generation runs and evaluation runs are separate. Re-evaluation must not call a model again unless the user creates a new generation run.
3. The Stable Core imports no database, queue, HTTP, UI, provider, evaluator, or observability SDK. Canonical Bundles are its boundary.
4. In Server deployments PostgreSQL is authoritative. Redis/BullMQ transports at-least-once work and may be rebuilt from durable run state.
5. Queue handlers are idempotent and classify errors as retryable or unrecoverable.
6. Unimplemented functionality fails explicitly. Production code never returns fixtures, random scores, or synthetic “successful” responses.
7. Aggregate scores retain links to dimension scores, evidence, framework version, and evaluator configuration.
8. Prompt attribution starts as `hypothesized`; only linked controlled intervention evidence may change it to `supported`, `rejected`, or `inconclusive`.
9. Raw provider SDK objects stay inside adapters. Cross-process inputs use versioned contracts.
10. Project/tenant scope belongs in every persistence query once multi-user support is introduced.
11. Secrets and raw sensitive conversations are not written to ordinary logs.
12. Plugin manifest validation never imports code. In-process plugin loading remains deny-by-default and requires an explicit trust decision.
13. A controlled ablation must keep the model, evaluator, dataset, and all non-intervened factors fixed; averages cannot hide an unrecovered hard target or a newly failed control.

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before changing process boundaries or storage.

## Code expectations

- Use typed Python and strict TypeScript; do not bypass uncertainty with `Any`/`any`, unchecked casts, or non-null assertions without a documented invariant.
- Preserve deterministic ordering, canonical hashing, finite-number checks, and explicit version rejection in the Python Core.
- Validate data at HTTP, queue, provider, and import boundaries.
- Use UTC timestamps in ISO 8601 at APIs and `timestamptz` in PostgreSQL.
- Include stable machine-readable error codes and a safe human-readable message.
- Keep modules small enough to test without starting the entire system.
- Prefer a database transaction for state transitions that must be atomic.
- Add a migration for every schema change. Do not silently edit an already released migration.
- Make retry, timeout, cancellation, and partial-failure behavior explicit for external calls.
- Keep comments focused on why a constraint exists, not a restatement of the code.

## Tests

Every behavior change needs the smallest appropriate automated test:

- **Unit tests:** validation, state transitions, scoring math, retry classification;
- **Contract tests:** Canonical Bundle/Report, plugin, API, and queue payload compatibility;
- **Integration tests:** repositories, migrations, jobs, idempotency, provider normalization;
- **End-to-end tests:** critical user workflows once the UI is connected;
- **Regression fixtures:** evaluator behavior, with no real credentials or private conversations.

A deterministic fake provider or explicit ablation fixture is acceptable inside tests. It must not be reachable from production configuration or shown as a real evaluation result.

Bug fixes should normally include a test that fails before the fix. Statistical code needs tests for empty, missing, tied, failed, repeated, and non-finite inputs.

## Database and queue changes

Database pull requests should document forward migration, rollback or recovery strategy, expected lock duration, index impact, and compatibility with workers running the previous version.

Queue changes should:

- add or update the payload in `packages/queue` rather than redefining it in an app;
- use a new job type or payload version for incompatible changes;
- include duplicate-delivery and process-interruption tests;
- put only references and small metadata in Redis, not entire sensitive datasets;
- preserve a durable failure record that users can inspect.

## Commits and pull requests

Keep commits focused and write imperative summaries such as `Add immutable framework publishing`. A pull request should include:

- what user or operator problem it solves;
- implementation and important trade-offs;
- screenshots for visible UI changes;
- migrations and deployment order, if any;
- tests performed;
- security/privacy impact;
- documentation changes;
- follow-up work intentionally left out.

Reviewers may ask for a smaller pull request when unrelated refactoring obscures correctness or migration risk.

## Documentation and terminology

Use the technical term first and explain it in plain language when the audience may not know it. Keep Chinese and English README claims aligned. Mark planned features clearly; architecture diagrams are not evidence that a component is implemented.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
