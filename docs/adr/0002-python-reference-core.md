# ADR 0002: Use a Python reference core

- Status: Accepted
- Date: 2026-09-13
- Scope: Prompt Regression Diagnosis, Phase 1

## Context

The application is primarily TypeScript, while the statistical and scientific-computing ecosystem needed for diagnosis is strongest in Python. Embedding database, queue, or web concerns in the analytical implementation would make its behavior difficult to reproduce and difficult to port.

## Decision

Phase 1 will define a separately versioned Python package as the reference implementation of diagnosis semantics.

- The core accepts one validated diagnosis-input bundle and returns one diagnosis-result bundle. It has no direct database, queue, HTTP, model-provider, telemetry-backend, or secret-store access.
- Domain calculations are exposed as deterministic functions. A thin process entry point may read and write bundles; operational logging goes to a separate channel and never changes the result.
- Python and dependency versions are locked for releases. The emitted result records the core version and algorithm/configuration hash; adapters must also record a dependency-lock digest and explicit random seed when their algorithm is stochastic.
- Stable sorting and tie-breaking are specified. Non-finite numbers, unsupported encodings, and invalid schemas fail explicitly instead of being silently coerced.
- The golden suite grows to cover empty, missing, tied, failed, repeated, and non-finite inputs. Released fixtures and their expected outputs form the cross-language conformance suite.
- TypeScript orchestration invokes the core through the engine port in [ADR 0004](./0004-ports-and-adapters.md); it does not import Python implementation details.
- A future implementation in another language is acceptable only if it passes the same versioned conformance suite. It must advertise a distinct engine version when numerical behavior differs.

The Python core is an executable reference, not a causal oracle. Its conclusions remain subject to the evidence rules in [ADR 0005](./0005-hypothesis-evidence-state-machine.md).

## Consequences

Analytical behavior can evolve independently of the web stack and can be reviewed by data-science contributors. The project takes on a second locked toolchain and a process boundary, so release checks must test packaging, protocol errors, cancellation, timeouts, and byte-for-byte repeatability for deterministic fixtures.
