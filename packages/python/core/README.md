# prompt-regression-core

`prompt-regression-core` is the deterministic, vendor-neutral reference engine for
Prompt Regression Diagnosis. It accepts a versioned regression bundle and produces
an evidence-linked diagnosis report.

The package deliberately has no model-provider, database, queue, web-framework, or
evaluation-platform dependency. Integrations implement the protocols in `ports.py`.

This is an alpha API. The `v1alpha1` bundle/report contracts are versioned, but may
still receive breaking changes before the first stable release.

## Command line

From the repository root with `packages/python/core/src` on `PYTHONPATH`:

```console
python -m prompt_regression_core validate regression-bundle.json
python -m prompt_regression_core diagnose regression-bundle.json --out report.json
python -m prompt_regression_core diagnose regression-bundle.json --format markdown --out report.md
```

Pass `-` instead of a bundle path to read standard input. Use
`--require-supported-hypothesis` in CI when a detected regression must not pass
unless at least one hypothesis crosses the controlled-evidence gate.

## Evidence boundary

Similarity, tags, prompt diff, clustering, or an LLM explanation can only create
a `hypothesized` item. The reference scorer marks it `supported` only when:

- the configured minimum target and control sample sizes are present;
- target recovery crosses the configured threshold;
- every hard-failure target recovers;
- no new control case fails; and
- the worst individual control damage is within the configured limit.

Every ablation run must reference the planned variant, cover the same immutable
dataset, and use the same model and evaluator snapshots as the paired baseline
and candidate runs. Missing or conflicting evidence remains explicit; Core never
generates substitute model outputs.
