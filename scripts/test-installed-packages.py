"""Run from an isolated venv after installing built wheels, without PYTHONPATH."""

import csv
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

import prompt_regression_core
import prompt_regression_plugin_sdk
import prompt_regression_importer_promptfoo


root = Path(__file__).resolve().parents[1]
for module in (prompt_regression_core, prompt_regression_plugin_sdk, prompt_regression_importer_promptfoo):
    assert not Path(module.__file__).resolve().is_relative_to(root), "Acceptance must import installed wheels, not checkout sources"
env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}


def run(args, cwd, expected=0, extra=None):
    result = subprocess.run([sys.executable, *args], cwd=cwd, env={**env, **(extra or {})}, capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert result.returncode == expected, f"{args[0]} returned {result.returncode}: {result.stderr}"
    return result


with tempfile.TemporaryDirectory(prefix="prs-package-acceptance-") as directory:
    workspace = Path(directory)
    example = root / "examples/missing-information-regression/regression-bundle.json"
    bundle = workspace / "paired results.json"
    bundle.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
    run(["-m", "prompt_regression_core", "validate", str(bundle)], workspace)
    run(["-m", "prompt_regression_core", "check", str(bundle), "--out-dir", "reports"], workspace, 3)
    report = json.loads((workspace / "reports/report.json").read_text(encoding="utf-8"))
    assert report["hypotheses"][0]["verification_status"] == "supported"
    with (workspace / "reports/regressions.csv").open(newline="", encoding="utf-8") as handle:
        assert len(list(csv.DictReader(handle))) == 2
    manifest = root / "plugins/official/promptfoo/prompt-regression-plugin.json"
    run(["-m", "prompt_regression_plugin_sdk", "validate", str(manifest)], workspace)
    run(["-m", "prompt_regression_plugin_sdk", "validate", str(manifest), "--load-kind", "EvalImporter"], workspace, 2)
    run(["-m", "prompt_regression_plugin_sdk", "validate", str(manifest), "--load-kind", "EvalImporter", "--trust-in-process"], workspace)
    request = runpy.run_path(str(root / "plugins/official/promptfoo/tests/test_importer.py"))["_request"]()
    request_path = workspace / "promptfoo request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    run(["-m", "prompt_regression_importer_promptfoo", str(request_path), "--out", "imported.json"], workspace)
    run(["-m", "prompt_regression_core", "validate", "imported.json"], workspace)
    action_env = {
        "GITHUB_WORKSPACE": str(workspace), "GITHUB_OUTPUT": str(workspace / "outputs"),
        "GITHUB_STEP_SUMMARY": str(workspace / "summary"), "PRS_BUNDLE": bundle.name,
        "PRS_OUTPUT_DIRECTORY": "action reports", "PRS_MAX_REGRESSIONS": "0",
        "PRS_REQUIRE_SUPPORTED": "false", "PRS_INPUT_FORMAT": "canonical",
    }
    runner = str(root / ".github/actions/prompt-regression/run.py")
    run([runner], workspace, 3, action_env)
    assert "passed=false" in (workspace / "outputs").read_text(encoding="utf-8")
    run([runner], workspace, 0, {**action_env, "PRS_OUTPUT_DIRECTORY": "passing reports", "PRS_MAX_REGRESSIONS": "2"})
    run([runner], workspace, 3, {**action_env, "PRS_BUNDLE": request_path.name, "PRS_INPUT_FORMAT": "promptfoo", "PRS_OUTPUT_DIRECTORY": "import reports"})
    run([runner], workspace, 2, {**action_env, "PRS_OUTPUT_DIRECTORY": "../outside"})
    run([runner], workspace, 2, {**action_env, "PRS_MAX_REGRESSIONS": "$(echo injected)"})
    run([runner], workspace, 2, action_env)  # Existing output must not publish stale reports.
print("PASS installed wheels: CLI gates, exports, trusted plugin loading, Promptfoo import and Action inputs")
