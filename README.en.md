# Prompt Regression Studio

[中文](./README.md) · [Chinese local setup](./docs/GETTING_STARTED.md) · [Architecture](./docs/ARCHITECTURE.md) · [Contracts](./contracts/README.md) · [ADRs](./docs/adr/) · [Contributing](./CONTRIBUTING.md)

An open-source, evidence-first framework for diagnosing LLM prompt regressions.

It is designed to answer more than “which prompt scored higher?” It asks whether the candidate actually regressed, which scenarios failed, which changed segment is a plausible cause, and whether a controlled experiment supports that hypothesis.

> **Project status: pre-alpha; not suitable for production decisions.**
>
> The reproducible diagnosis slice now runs through the CLI, HTTP API, or browser, and paired Promptfoo v3 results can be imported under strict confounder checks. Diagnosis records can be persisted after applying the initial PostgreSQL migration. Real-model ablations, authentication, and tenant isolation are not complete. Use this release only in a trusted or isolated environment.

## Why this is not another general Eval clone

Promptfoo, Langfuse, Phoenix, and related projects already cover important parts of evaluation execution, observability, and experiment analysis. This project focuses specifically on **post-Eval regression diagnosis**: it consumes pinned baseline and candidate results, creates falsifiable root-cause hypotheses, and gathers evidence through controlled ablations.

```text
Baseline → Candidate → Regression → Cluster → Diff → Hypothesis → Ablation → Evidence → Report
```

| Stage                 | Meaning                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| Baseline              | The trusted prompt version and evaluation results used as the reference                           |
| Candidate             | The changed prompt version and results under investigation                                        |
| Regression            | A paired case becomes a failure or drops past the configured metric threshold                     |
| Failure cluster       | Similar regressed cases are grouped so they can be investigated together                          |
| Prompt diff           | Added, removed, and rewritten content is located by stable segment ID                             |
| Root-cause hypothesis | A testable statement linking a change, a failure group, and a possible mechanism—not a conclusion |
| Ablation              | One change is reverted while other conditions remain fixed; target and control cases are rerun    |
| Evidence              | Target recovery, control damage, sample size, and complete object links are recorded              |
| Diagnosis report      | Regression facts, hypotheses, experiments, evidence, and next actions are assembled               |

An LLM may propose a hypothesis, but it cannot declare a root cause. Only controlled-ablation evidence may move a hypothesis from `hypothesized` to `supported`, `rejected`, or `inconclusive`. These statuses describe the current experiment, not universal causality across every model, dataset, or environment.

## What is implemented in this slice

The Python reference core currently provides a narrow but real vertical slice:

- versioned `v1alpha1` JSON input and report contracts, with explicit rejection of unknown versions, invalid references, and tampered prompt hashes;
- paired baseline/candidate comparison for hard failures and metric regressions;
- stable-segment prompt diffing, deterministic metadata-based failure clustering, and rule-based hypotheses;
- single-segment revert plans with target and control cases;
- evidence scoring from recovery ratio, minimum samples, worst-case control damage, complete hard-failure recovery, and new control failures;
- byte-deterministic report IDs plus JSON and human-readable Markdown output;
- a typed Plugin SDK with strict manifests, Core compatibility checks, and deny-by-default in-process loading;
- an original Promptfoo v3 importer and CLI that preserves provenance and rejects model, provider, evaluator, or test-contract confounders;
- a constrained Node-to-Python process adapter and `POST /v1/diagnoses` endpoint with cancellation, size, timeout, safe-error, and concurrency boundaries;
- a browser diagnosis workspace for file or pasted bundle input, preflight checks, cancellation/retry, and Chinese evidence-first report presentation;
- a versioned initial PostgreSQL migration plus durable diagnosis inputs, lifecycle, reports, safe failures, history, and report reopening;
- an executable example and automated tests that do not require a live LLM.

The current Mock ablation fixture only reads **explicit, prewritten results** from the example bundle. It tests pipeline behavior, links, and decision rules. It does not call a real model, infer missing outputs, or demonstrate real-world prompt quality.

## Run the first diagnosis in five minutes

Requirement: Python 3.12 or newer. The reference core currently uses only the Python standard library, so no dependency installation is required.

### Windows PowerShell

From the repository root:

```powershell
$env:PYTHONPATH = "packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --out diagnosis-report.json --require-supported-hypothesis
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --format markdown --out diagnosis-report.md
```

### macOS / Linux

From the repository root:

```bash
export PYTHONPATH="packages/python/core/src"
python -m prompt_regression_core validate examples/missing-information-regression/regression-bundle.json
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --out diagnosis-report.json --require-supported-hypothesis
python -m prompt_regression_core diagnose examples/missing-information-regression/regression-bundle.json --format markdown --out diagnosis-report.md
```

`validate` checks input integrity only. `diagnose` emits machine-readable JSON or review-friendly Markdown. `--require-supported-hypothesis` returns a non-zero status when regressions exist but no hypothesis passes the evidence gate, making it suitable for a CI gate.

Run the tests:

```console
python scripts/run-python-tests.py
pnpm test
```

The first command covers Core, the Plugin SDK, and official Python plugins. The second runs the Python and TypeScript suites together.

Read the [missing-information example](./examples/missing-information-regression/README.md) for its business meaning and the [contract guide](./contracts/README.md) for field-level semantics.

## Technology and responsibility

| Technology or module           | Responsibility                                                        | Current boundary and likely evolution                                                                              |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Python 3.12 reference core     | Vendor-neutral domain model and diagnosis engine                      | Deterministic diagnosis and strict causal gates exist; repeated real experiments and statistical intervals remain  |
| JSON Schema Draft 2020-12      | Language-neutral contracts for bundles, reports, and plugin manifests | Three strict `v1alpha1` contracts exist; breaking changes remain possible before stable                            |
| Python `Protocol` + Plugin SDK | Standard sockets, compatibility, and explicit trust checks            | Eleven extension kinds exist; untrusted plugins still need process or container isolation                          |
| Promptfoo official importer    | Converts paired Promptfoo v3 results into the canonical bundle        | v3 and provenance retention are implemented; Langfuse, OpenInference, and generic CSV remain                       |
| CLI + automated tests          | Local/CI operation without a live LLM                                 | JSON/Markdown output and cross-language tests exist; property and performance suites should grow                   |
| React + Vite + TypeScript      | Prompt management and diagnosis UI                                    | Upload, execution, durable history, and evidence reports are connected; per-case drill-down and browser E2E remain |
| Fastify + TypeBox              | HTTP boundary between clients and Core                                | `POST /v1/diagnoses` is connected; authentication, idempotency, and asynchronous jobs remain                       |
| PostgreSQL + Drizzle           | Relational/versioning and diagnosis persistence                       | First-class diagnosis records and initial migration exist; backup/restore, upgrade, and tenant tests remain        |
| Redis + BullMQ + Node worker   | Existing background-work and worker-lifecycle foundation              | Diagnosis jobs, real provider/evaluator adapters, rate limits, and cost controls remain                            |

React, Fastify, PostgreSQL, and BullMQ do not need replacement in the short term. The important change is the boundary: diagnosis semantics remain in Stable Core, while the web, API, worker, database, and providers connect through versioned contracts and ports. Replacing a provider, queue, or persistence adapter must not redefine “regression” or “evidence.” See [ADR 0001](./docs/adr/0001-diagnosis-layer-boundary.md), [ADR 0002](./docs/adr/0002-python-reference-core.md), and [ADR 0004](./docs/adr/0004-ports-and-adapters.md).

## Repository layout

```text
contracts/                    Language-neutral input/report JSON contracts
packages/python/core/         Stable domain model, pipeline, ports, strategies, and CLI
packages/python/plugin-sdk/   Plugin manifests, compatibility, and explicit trust boundary
packages/diagnosis-engine/    Constrained Node-to-Python Core adapter
examples/                     Minimal reproducible diagnosis scenarios
plugins/official/promptfoo/   Promptfoo v3 paired-evaluation importer and CLI
plugins/                      Other official/community adapter boundaries and trust rules
experimental/                 Algorithms without compatibility promises yet
docs/adr/                     Architectural decisions and their reasoning
apps/api, apps/web, apps/worker
                              HTTP diagnosis entry point and product/background layers
packages/contracts, db, queue/
                              Existing TypeScript contract, persistence, and queue foundation
```

Key entry points:

- [Regression Bundle input schema](./contracts/regression-bundle/v1alpha1.schema.json)
- [Diagnosis Report output schema](./contracts/diagnosis-report/v1alpha1.schema.json)
- [Plugin Manifest schema](./contracts/plugin-manifest/v1alpha1.schema.json)
- [Python Core notes](./packages/python/core/README.md)
- [Promptfoo importer notes](./plugins/official/promptfoo/README.md)
- [Hypothesis/evidence state machine](./docs/adr/0005-hypothesis-evidence-state-machine.md)
- [Architecture](./docs/ARCHITECTURE.md) and [roadmap](./docs/ROADMAP.md)

## Third-party source policy

The repository is licensed under [Apache License 2.0](./LICENSE). No Promptfoo, Langfuse, or Phoenix source code is copied. The Promptfoo adapter is an original implementation of its documented v3 JSON wire format using repository-created synthetic fixtures.

Future copied code requires path-and-commit verification, preserved license and copyright notices, and recorded provenance and modifications. Verified MIT material from Promptfoo and non-`ee/` Langfuse paths may be considered. Langfuse `ee/` code and Elastic License 2.0 code from the Phoenix main repository must not be copied into the Apache-2.0 Core. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md), the [provenance inventory](./docs/code-provenance.yml), and [ADR 0006](./docs/adr/0006-third-party-code-reuse.md).

## Security and contributions

- Run this version only in a trusted local development environment; do not expose it directly to the public internet.
- Follow the [security policy](./SECURITY.md) and do not disclose vulnerabilities through a public issue.
- Read the [contribution guide](./CONTRIBUTING.md) and [code of conduct](./CODE_OF_CONDUCT.md) before contributing.
