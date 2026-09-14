# ADR 0006: Control third-party code reuse

- Status: Accepted
- Date: 2026-09-13
- Scope: Repository-wide policy, introduced for Prompt Regression Diagnosis

## Context

The project is Apache-2.0 licensed and may learn from established evaluation and observability projects. A repository-level license label is not enough to authorize copying: licenses can vary by path, edition, and revision. Untracked snippets or close translations also make attribution and later removal impractical.

## Decision

Design reference, protocol integration, package dependency, and copied source are distinct categories. Copying includes translated code, tests, fixtures, generated code, comments, and close adaptations—not only verbatim production files.

| Upstream area                                                                       | Reuse rule                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promptfoo material verified as MIT at the selected revision                         | May be reused when needed. Record exact source and revision, preserve copyright and MIT license notices, document modifications, and complete normal security review. |
| Langfuse paths outside every ee directory, verified as MIT at the selected revision | May be reused under the same provenance and notice requirements. Path-level verification is mandatory.                                                                |
| Langfuse ee paths                                                                   | Must not be copied into this repository, translated, or used as a source for close adaptation.                                                                        |
| Arize Phoenix main repository material governed by Elastic License 2.0              | Must not be copied into the Apache-2.0 core. Integrate only through documented, independently implemented protocols or APIs behind an adapter.                        |

Before copied code is merged, the contributor must:

1. inspect the exact upstream revision and path rather than relying on a badge or repository summary;
2. add one entry per copied unit to docs/code-provenance.yml with upstream URL, immutable revision, source path, destination, SPDX identifier, copyright notice, modifications, and reviewer;
3. add the required attribution or license text to THIRD_PARTY_NOTICES.md and preserve source headers;
4. run dependency, security, patent-notice, and license-compatibility review; and
5. decline reuse when ownership or license scope is ambiguous.

Package dependencies follow the dependency/SBOM review process and are not treated as copied source. Clean-room protocol adapters must be based on public specifications or observed protocol behavior and must not reproduce protected implementation text.

For the current slice, no third-party code has been copied. Promptfoo, Langfuse, and Phoenix are design references only; the machine-readable inventory therefore remains empty.

## Consequences

Permissively licensed code can be reused with durable attribution, while edition-specific and source-available boundaries remain enforceable. Contributors incur a small review burden, but downstream users receive a clear, machine-readable provenance trail.
