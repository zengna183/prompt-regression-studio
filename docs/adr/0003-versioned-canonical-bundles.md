# ADR 0003: Exchange versioned canonical bundles

- Status: Accepted
- Date: 2026-09-13
- Scope: Prompt Regression Diagnosis, Phase 1

## Context

Database rows and in-memory TypeScript objects are not durable analytical contracts. Diagnosis must remain reproducible after schemas, adapters, and implementations change, and an exported result must be independently inspectable.

## Decision

The boundary between orchestration and the diagnostic engine is a pair of immutable, versioned JSON bundles: diagnosis-input and diagnosis-result.

Every bundle contains:

- a full kind-and-version discriminator in `schema_version`;
- an opaque stable bundle/report identifier;
- diagnostic-engine and strategy/configuration versions in the report;
- immutable IDs and snapshots for Prompt, Dataset, EvalRun, model, evaluator, and configuration inputs;
- normalized records plus missing, redacted, and failed-item metadata;
- deterministic ordering rules and artifact digests;
- for results, the normalized input-bundle SHA-256, algorithm/configuration version, hypothesis records, evidence links, recommendations, and evidence status.

The bundle is the canonical interchange artifact, not a mirror of database tables.

- UTF-8 encoding, timezone-aware timestamps, stable key ordering, defined array ordering, and JSON-compatible finite numbers are required before hashing.
- The Core hashes the fully parsed, normalized input object; transport headers and logs are outside that object. No consumer may rewrite a saved bundle in place.
- Readers reject an unsupported major schema version and any unknown required feature. Backward-compatible additions use a minor version; breaking meaning or required fields use a new major version.
- A future converter must emit a new bundle linked to the original digest and record its converter version. Migration never changes the original saved artifact.
- Full validation and digest verification happen before calculation. Partial acceptance is reported as an explicit result only when the schema defines that mode.
- Raw secrets are forbidden. Sensitive prompt or response material is included only when required, project-authorized, and accompanied by redaction and retention metadata.

The schema, examples, and conformance fixtures are released together. Schema support windows are documented before a version is retired.

## Consequences

Bundles provide a stable replay, export, and audit boundary and prevent database implementation details from entering the core. They add storage and conversion overhead, but permit independent verification and future engines without changing application persistence.
