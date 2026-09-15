# Changelog

All notable changes to this project will be documented in this file. The format follows Keep a Changelog, and releases use semantic versioning.

## [Unreleased]

### Added

- Seven accepted architecture decisions covering the diagnosis boundary, Python reference core, versioned contracts, ports and adapters, the hypothesis/evidence state machine, third-party reuse controls, and the constrained Node-to-Python process boundary.
- A third-party notices file and machine-readable code-provenance inventory. No third-party code is copied in this slice.
- A dependency-free Python 3.12 reference core with explicit diagnosis domain objects and vendor-neutral extension ports.
- A deterministic vertical slice covering paired regression detection, failure clustering, stable-segment diff, root-cause hypotheses, single-segment revert plans, fixture-backed ablation runs, evidence gates, and linked reports.
- `validate` and `diagnose` CLI commands with atomic JSON or Markdown report writes and an optional evidence gate exit code for CI.
- Draft 2020-12 JSON Schemas for the `v1alpha1` regression bundle, diagnosis report, and plugin manifest, plus cross-language Ajv validation.
- A missing-information regression example and automated tests for supported, rejected, inconclusive, unverified, no-regression, invalid-input, and deterministic-output paths.
- A typed Python Plugin SDK with strict manifests, Core compatibility checks, explicit entry-point resolution, and a deny-by-default in-process trust gate.
- An original-code Promptfoo `EvaluateSummaryV3` importer and CLI with paired-run confounder checks, source provenance preservation, stable errors, offline fixtures, and a loadable official-plugin manifest.
- A constrained Node-to-Python diagnosis adapter with fixed commands, standard-input transport, resource limits, cancellation, safe public errors, and process-failure tests.
- A synchronous `POST /v1/diagnoses` Fastify endpoint with request cancellation, bounded concurrency, stable HTTP error mapping, and dependency injection for isolated tests.
- A real HTTP-to-Node-to-Python smoke test for the golden regression bundle.
- A responsive browser diagnosis workspace with file/paste input, preflight checks, cancellation/retry, strict response parsing, and evidence-first Chinese reporting.
- Durable PostgreSQL diagnosis runs, a versioned initial SQL migration, safe terminal failures, history/detail APIs, and browser report history.
- A repeatable Windows bootstrap and environment check, project-scoped Python environment, and shared VS Code tasks/settings for first-time contributors.
- Cross-platform Python executable discovery for the root test command and HTTP smoke test, preferring the project virtual environment when present.
- Automatic Docker CLI discovery for Microsoft Store per-user installs and conventional all-user installs on Windows.
- A documented Worker health configuration using port 4101 by default to avoid the common Windows QQ port collision on 4001.

### Changed

- Re-centered the architecture, roadmap, and bilingual README from a generic evaluation platform to an Eval-after diagnosis framework.
- Repaired the existing TypeScript monorepo package build ordering, ioredis v6 import, repository error typing, and strict API option handling.
- Tightened controlled-ablation validation so model/evaluator changes, incomplete or duplicate results, broken references, unrecovered hard failures, and worst-case control damage cannot be hidden by an average score.
- Updated GitHub Actions to Node.js 24-based action releases so new CI runs no longer emit the Node.js 20 retirement warning.
