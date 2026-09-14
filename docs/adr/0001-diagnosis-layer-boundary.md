# ADR 0001: Isolate the Prompt Regression Diagnosis layer

- Status: Accepted
- Date: 2026-09-13
- Scope: Prompt Regression Diagnosis, Phase 1

## Context

Generation, evaluation, and diagnosis answer different questions. Combining them would let a diagnostic run silently regenerate responses, rescore old evidence, or mutate the prompt under investigation. It would also make a plausible explanation look more causal than its evidence permits.

## Decision

Prompt Regression Diagnosis is a read-only analytical layer over immutable, version-pinned artifacts.

- Its only computational input is a validated canonical bundle defined by [ADR 0003](./0003-versioned-canonical-bundles.md).
- It may compare prompt blocks, paired case results, dimension scores, failures, and uncertainty; it emits hypotheses, evidence references, diagnostics, and explicit error records.
- It must not call a model provider, generate responses, edit prompts, or change source run records. A test-only runner may replay evaluation results that are explicitly present in the input bundle, but it cannot infer or synthesize missing outputs or scores.
- Application orchestration is responsible for authorization, project scoping, redaction, bundle export, persistence, and audit events. Diagnostic algorithms receive only the minimum required data.
- Results are append-only and identify every source artifact, schema version, algorithm version, and configuration needed to reproduce them.
- Observational or diff-derived findings remain unverified hypotheses. Causal language is gated by [ADR 0005](./0005-hypothesis-evidence-state-machine.md).
- Missing, incompatible, or corrupt evidence produces an explicit incomplete or failed result; the layer never fills gaps with synthetic evidence.

Phase 1 builds controlled intervention plans and can replay explicit fixtures to test the evidence state machine. It does not execute a real provider intervention, rewrite a stored prompt, provide a general observability backend, or autonomously declare a root cause.

## Consequences

Diagnosis can be rerun without provider cost and without changing historical results. The boundary makes provenance and failure states inspectable, at the cost of an explicit export and orchestration step. End-to-end tests must prove that a diagnosis cannot write to source prompt, generation, or evaluation records.
