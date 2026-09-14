# Third-Party Notices

This file records source code copied or vendored into this Apache-2.0 repository beyond ordinary package-manager dependencies. Dependency packages retain their own license metadata and notices and are reviewed through the dependency/SBOM process.

## Current copied-source inventory

No third-party source code is copied into the repository. The official Promptfoo importer is an original implementation of Promptfoo's documented versioned JSON output format; its synthetic/redacted fixtures were created for this repository. Accordingly, there is no third-party copyright or license text to reproduce here.

The authoritative machine-readable inventory is [docs/code-provenance.yml](./docs/code-provenance.yml), where copied_code is empty.

## Reuse boundaries

The following are policy boundaries, not claims that upstream code is included:

- [Promptfoo](https://github.com/promptfoo/promptfoo): material verified as MIT at the selected revision may be reused when needed, provided its copyright and MIT license notice are preserved and provenance is recorded.
- [Langfuse](https://github.com/langfuse/langfuse): only paths outside every ee directory that are verified as MIT at the selected revision may be reused with notices and provenance. Langfuse ee code must not be copied.
- [Arize Phoenix](https://github.com/Arize-ai/phoenix): main-repository code governed by Elastic License 2.0 must not be copied into this Apache-2.0 core. Any integration must use an independently implemented public protocol or API adapter.

See [ADR 0006](./docs/adr/0006-third-party-code-reuse.md) for the required intake and review process. If copied code is added later, its notice must be added here in the same change.
