# Official Promptfoo importer

`prompt-regression-importer-promptfoo` converts a **paired** baseline/candidate
Promptfoo JSON export into the vendor-neutral `RegressionBundle` used by Prompt
Regression Diagnosis Core. It is intentionally an importer, not a Promptfoo
runtime dependency.

通俗地说：先用 Promptfoo 跑两次完全相同的测试，一次用旧 Prompt，一次用
新 Prompt；这个插件负责把两份结果严格对齐，再交给我们的“退化检测与归因”
流程。它不会因为看到低分就猜测故障原因。

## Supported boundary

- Input must be the normal JSON output envelope containing `evalId` and
  `results.version === 3` (`EvaluateSummaryV3`).
- Versions 1, 2, future/unknown versions, and the bare summary without its
  output envelope are rejected. Silent best-effort conversion would make an
  experiment irreproducible.
- A file containing several prompts or providers needs a `selection` that
  resolves to exactly one prompt/provider signature.
- Baseline and candidate must have exactly the same `testIdx` set, `vars`,
  `testCase`, named-score keys, declared model configuration, and declared
  evaluator configuration.
- The complete selected row `provider` object is fingerprinted and must also be
  identical. This includes its display `label` and any additive fields. A label
  is often cosmetic, but changing it may also mean a different configured alias;
  the importer takes the conservative choice and asks the caller to make the two
  exports identical instead of silently guessing equivalence.
- A row with `failureReason: 2`, a non-empty `error`, a response error, or
  `gradingResult.metadata.graderError` is rejected as an execution failure. It
  is never converted into an ordinary failed evaluation.

## Request shape

The importer accepts a Python mapping or equivalent JSON. The `export` values
below are the unchanged Promptfoo JSON output envelopes. Explicit
`model_config` and `evaluator_config` snapshots are required because provider
IDs alone cannot prove that temperature, seed, judge, rubric, or other
confounders stayed fixed.

```json
{
  "schema_version": "prompt-regression.import.promptfoo/v1alpha1",
  "bundle_id": "bundle-v1-v2",
  "diagnosis_requested_at": "2026-09-14T08:10:00Z",
  "project": { "id": "project-1", "name": "Support" },
  "prompt": {
    "id": "prompt-1",
    "project_id": "project-1",
    "name": "Support prompt"
  },
  "dataset": {
    "id": "dataset-1",
    "project_id": "project-1",
    "name": "Regression suite"
  },
  "baseline": {
    "export": { "evalId": "...", "results": { "version": 3 } },
    "selection": { "prompt_idx": 0, "provider_id": "openai:chat:model" },
    "prompt_version": {
      "id": "prompt-1-v1",
      "prompt_id": "prompt-1",
      "version": 1,
      "segments": [
        {
          "id": "policy",
          "kind": "policy",
          "content": "Ask when required information is missing.",
          "ordinal": 0,
          "semantic_tags": ["missing_information"]
        }
      ]
    },
    "model_config": { "provider_id": "openai:chat:model", "temperature": 0 },
    "evaluator_config": { "judge": "judge-id", "rubric_revision": "r1" }
  },
  "candidate": {
    "export": { "evalId": "...", "results": { "version": 3 } },
    "selection": { "prompt_idx": 0, "provider_id": "openai:chat:model" },
    "prompt_version": {
      "id": "prompt-1-v2",
      "prompt_id": "prompt-1",
      "version": 2,
      "segments": [
        {
          "id": "policy",
          "kind": "policy",
          "content": "Answer immediately.",
          "ordinal": 0,
          "semantic_tags": ["missing_information"]
        }
      ]
    },
    "model_config": { "provider_id": "openai:chat:model", "temperature": 0 },
    "evaluator_config": { "judge": "judge-id", "rubric_revision": "r1" }
  },
  "detection": {
    "primary_metric": "groundedness",
    "metric_drop_threshold": 0.2
  }
}
```

`selection` may contain `prompt_idx`, `prompt_id`, `provider_id`, and
`provider_label`. It may be omitted only when the export contains exactly one
prompt/provider signature.

## Python use

```python
from prompt_regression_importer_promptfoo import PromptfooImporter

bundle = PromptfooImporter().load("promptfoo-import-request.json")
```

Users who do not write Python can run the same conversion directly:

```console
prompt-regression-import-promptfoo promptfoo-import-request.json --out regression-bundle.json
```

Use `-` as the input or output path for standard input/output. File output is
written to a temporary file in the destination directory, flushed, and then
atomically replaced, so interruption cannot leave a partial bundle. Stable exit
codes are `0` (success), `2` (command usage), `3` (input/import rejection), and
`4` (output failure).

The plugin manifest exports a ready-to-use object at
`prompt_regression_importer_promptfoo:plugin`, as required by the Plugin SDK.
Hosts must still acknowledge the SDK's in-process trust boundary before loading
any Python plugin. The source manifest is `prompt-regression-plugin.json`; the
wheel also installs it under
`share/prompt-regression/plugins/promptfoo/`.

## Field mapping

| Promptfoo v3 field                                                | Core field                         | Notes                                                      |
| ----------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `vars`                                                            | `TestCase.input`                   | Paired exactly by `testIdx`; no flattening                 |
| `response.output`                                                 | `EvalResult.output_text`           | Non-text JSON output uses canonical JSON text              |
| `success`                                                         | `EvalResult.passed`                | Only assertion pass/fail; execution errors are rejected    |
| `score`                                                           | `MetricResult[promptfoo.overall]`  | Reserved aggregate metric                                  |
| `namedScores.*`                                                   | `MetricResult[*]`                  | Names and numeric values are preserved                     |
| grading/component reasons                                         | metric reason and result metadata  | Assertion metric/type/pass/score/reason are retained       |
| `evalId`, row `id`, `traceId`, `evaluationId`                     | `EvalResult.metadata.promptfoo`    | Source linkage remains auditable                           |
| explicit `metadata.failure_mode`                                  | `EvalResult.metadata.failure_mode` | Never inferred from text, score, or assertion reason       |
| selected `provider` object plus declared model/evaluator settings | run snapshots                      | Full provider fingerprint and both declarations must match |

Imported bundles contain no mock ablation results. Importing historical scores
can establish correlation and generate hypotheses, but only a later controlled
ablation may support or reject a causal hypothesis.

## Security and privacy

Promptfoo exports can include prompts, model outputs, variables, traces,
grading prompts, and other sensitive material. This adapter validates and
preserves relevant evidence; it is **not** a redaction tool. Redact before
sharing or committing an export. The checked-in fixtures use synthetic values
and explicit `[REDACTED ...]` placeholders.

## Provenance

This implementation is original code. No Promptfoo source code, tests, or
comments were copied. The wire-format behavior was written from these public,
official references, reviewed on 2026-09-14:

- [Promptfoo configuration reference — Evaluation outputs](https://github.com/promptfoo/promptfoo/blob/main/site/docs/configuration/reference.md#evaluation-outputs)
- [Promptfoo output formats](https://github.com/promptfoo/promptfoo/blob/main/site/docs/configuration/outputs.md)
- [Promptfoo repository](https://github.com/promptfoo/promptfoo)
- [Promptfoo MIT license](https://github.com/promptfoo/promptfoo/blob/main/LICENSE)

The adapter supports the documented v3 format, not an unversioned snapshot of
Promptfoo internals. Additive fields are tolerated inside upstream exports;
modeled request fields remain strict. If Promptfoo introduces v4, support must
be added deliberately with new compatibility fixtures.

## Offline tests

From the repository root, with Core, Plugin SDK, and this package on
`PYTHONPATH`:

```console
python -m unittest discover -s plugins/official/promptfoo/tests -v
```

Runtime code uses only the Python standard library plus
`prompt-regression-core`. The Plugin SDK is declared in the optional `test`
extra because it is needed only for manifest/loader contract tests.
