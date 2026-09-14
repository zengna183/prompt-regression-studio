# ADR 0005: Govern hypotheses with an evidence state machine

- Status: Accepted
- Date: 2026-09-13
- Scope: Prompt Regression Diagnosis, Phase 1

## Context

A prompt diff can identify correlation, not causation. If labels can be promoted without linked evidence, the product will overstate confidence and make later audit or correction impossible.

## Decision

Each hypothesis is an immutable, addressable claim about defined prompt blocks, outcomes, and pinned comparison conditions. Its assessment begins in `hypothesized` and may make exactly one validated transition:

| State        | Meaning and evidence gate                                                                                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hypothesized | A diff, association, heuristic, or human observation exists; no causal claim is permitted.                                                                                                           |
| supported    | A linked controlled intervention changes only the claimed factor under pinned conditions and passes the versioned support rule.                                                                      |
| rejected     | A linked controlled intervention meets the declared sample gate and crosses the versioned rejection rule. This rejects this hypothesis under the pinned conditions; it does not prove another cause. |
| inconclusive | Power, variance, missingness, execution failures, confounding, control damage, or mixed results prevent a decision. This does not mean “no effect.”                                                  |

The only Phase 1 transitions are:

- `hypothesized` to `supported`;
- `hypothesized` to `rejected`;
- `hypothesized` to `inconclusive`.

Interaction effects require a later factorial-ablation contract and are not a Phase 1 state.

A terminal assessment is never edited or downgraded in place. New evidence opens a successor assessment linked to its predecessor; the published view retains the previous assessment until the successor reaches a terminal state. The complete chain remains visible.

The Core report records the hypothesis ID, input-bundle digest, evidence and intervention-run IDs, decision-rule/configuration version, report timestamp, and machine-readable rationale. Server persistence stores the immutable bundle, lifecycle timestamps, terminal report, and safe failure state. A future append-only transition event must additionally record actor and transaction timestamp. The validator verifies the pinned Prompt, Dataset, EvalRun, evaluator, and model/configuration identities available at that boundary. Invalid or incomplete transitions fail explicitly.

The v1alpha1 support rule is deliberately conservative. It checks the worst individual control damage rather than only an average, requires every hard-failure target to recover, and permits no new control failures. `max_observed_control_damage`, `unrecovered_hard_targets`, and `new_control_failures` are stored as structured Evidence fields so a reporter cannot hide these gates inside prose. Later statistical strategies may add uncertainty intervals, but may not remove these audit facts from the evidence chain.

Reports may say “supported by controlled ablation under these pinned conditions” for the corresponding state. They must not turn any outcome into an unconditional “root cause” claim.

## Consequences

Users can distinguish suggestions from controlled evidence and independently audit every conclusion. Promotion takes more experimental work, and changed evidence creates additional assessment records rather than convenient in-place edits.
