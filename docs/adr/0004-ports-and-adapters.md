# ADR 0004: Put the diagnostic core behind ports and adapters

- Status: Accepted
- Date: 2026-09-13
- Scope: Prompt Regression Diagnosis, Phase 1

## Context

The first implementation needs local bundle replay and application-managed execution. Later deployments may use different artifact stores, workers, or protocol integrations. Direct imports between analytical code and infrastructure would make those choices permanent and weaken tests.

## Decision

The diagnosis subsystem follows a ports-and-adapters dependency rule:

    HTTP or queue adapter
            |
      application service
       /       |       \
    bundle   engine    result/audit
     port     port        ports
       \       |          /
         infrastructure adapters

- Domain policy and bundle contracts are at the center. They import no web framework, queue client, ORM model, provider SDK, or vendor telemetry type.
- The inbound application operation is idempotent: run diagnosis for a validated input-bundle digest and engine/configuration version.
- Outbound ports cover bundle loading, diagnostic-engine execution, result persistence, and audit publication. Authorization and transaction boundaries remain in the application service.
- The Python reference core is hosted by a process adapter behind the engine port. Timeouts, cancellation, exit codes, resource limits, and safe log capture are adapter responsibilities.
- Adapters normalize external identifiers, errors, timestamps, and payloads at the edge. Raw external objects never cross a port.
- Contract tests are shared by every adapter; deterministic fakes are allowed in tests but cannot be selected by production configuration.
- A Phoenix connection, if added, is an optional protocol/API adapter. No Phoenix implementation code enters the core.

These ports are internal seams during Phase 1, not a promised public plugin API. Stabilizing a third-party extension contract requires a later ADR and compatibility policy.

## Consequences

Local files, application storage, and future remote engines can share one domain contract. More interfaces and boundary tests are required, but infrastructure failures stay distinct from analytical conclusions and vendor licensing remains outside the Apache-2.0 core.
