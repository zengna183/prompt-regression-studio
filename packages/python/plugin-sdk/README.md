# Prompt Regression Plugin SDK

This alpha package defines the public contract between the vendor-neutral
Prompt Regression Core and optional integrations. It provides:

- a strict, typed plugin manifest;
- the eleven supported extension-point kinds;
- Core-version compatibility checks; and
- an explicit, trust-gated in-process loader.

It intentionally does **not** discover, import, execute, install, or contact
plugins during manifest validation. It contains no networking code and has no
third-party runtime dependencies beyond the project’s own Core package.

## Install

```console
python -m pip install prompt-regression-plugin-sdk
```

The alpha SDK supports `prompt-regression-core` versions from `0.1.0a1`
(inclusive) to `0.2.0` (exclusive).

## Manifest

```json
{
  "schema_version": "prompt-regression/plugin-manifest/v1alpha1",
  "plugin_id": "acme.promptfoo-importer",
  "name": "Acme Promptfoo Importer",
  "version": "0.1.0a1",
  "description": "Imports an approved Promptfoo result bundle.",
  "homepage": "https://example.com/acme-promptfoo-importer",
  "core_compatibility": {
    "minimum": "0.1.0a1",
    "maximum_exclusive": "0.2.0"
  },
  "entry_points": [
    {
      "kind": "EvalImporter",
      "target": "acme_promptfoo_importer:plugin"
    }
  ]
}
```

An entry-point target must be a public `module.path:attribute.path`. The target
must export a ready-to-use object instance that structurally implements the
corresponding protocol from `prompt_regression_core.ports`. The loader never
calls an implicit factory or constructor.

## Validate without executing plugin code

```python
from prompt_regression_plugin_sdk import ensure_core_compatible, loads_manifest

manifest = loads_manifest(manifest_json)
ensure_core_compatible(manifest, core_version="0.1.0a1")
```

These operations parse data only. They do not import the entry-point module.
The JSON boundary also rejects duplicate object keys and the non-standard
`NaN`, `Infinity`, and `-Infinity` values so validation is deterministic across
languages and runtimes.

## Explicit in-process loading

```python
from prompt_regression_plugin_sdk import (
    InProcessTrust,
    PluginKind,
    load_plugin,
)

loaded = load_plugin(
    manifest,
    PluginKind.EVAL_IMPORTER,
    core_version="0.1.0a1",
    trust=InProcessTrust.ACKNOWLEDGED,
)
importer = loaded.instance
```

## Trust boundary

Loading a Python module executes arbitrary code in the current process. The SDK
is not a sandbox. `load_plugin` therefore denies loading unless the caller
explicitly passes `InProcessTrust.ACKNOWLEDGED`, and emits an
`InProcessPluginWarning` when it proceeds. Only load code that was reviewed and
approved for the current environment. Untrusted plugins must run behind a
separate process or container boundary implemented by a host application.

## Supported extension points

- `EvalImporter`
- `TraceImporter`
- `ProviderAdapter`
- `EvaluatorAdapter`
- `FailureClusterer`
- `PromptParser`
- `SemanticDiffStrategy`
- `RootCauseStrategy`
- `AblationStrategy`
- `EvidenceScorer`
- `Reporter`

The Core’s internal `AblationRunner` port is deliberately not a public plugin
kind in this first contract. Execution policy remains under the host’s control.
