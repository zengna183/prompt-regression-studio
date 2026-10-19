"""Treat Action inputs as data, never as shell commands or dynamically imported code."""

import json
import os
from pathlib import Path
import sys

from prompt_regression_core.cli import main as check
from prompt_regression_importer_promptfoo.cli import main as import_promptfoo


def main():
    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    source = (workspace / os.environ["PRS_BUNDLE"]).resolve()
    destination = (workspace / os.environ["PRS_OUTPUT_DIRECTORY"]).resolve()
    if not source.is_relative_to(workspace) or not destination.is_relative_to(workspace):
        raise ValueError("Input and output paths must stay within GITHUB_WORKSPACE")
    if not source.is_file():
        raise ValueError("Input JSON file does not exist")
    limit = os.environ["PRS_MAX_REGRESSIONS"]
    if not limit.isascii() or not limit.isdecimal():
        raise ValueError("max-regressions must be a nonnegative integer")
    require = os.environ["PRS_REQUIRE_SUPPORTED"]
    if require not in ("true", "false"):
        raise ValueError("require-supported-hypothesis must be true or false")
    input_format = os.environ["PRS_INPUT_FORMAT"]
    if input_format not in ("canonical", "promptfoo"):
        raise ValueError("input-format must be canonical or promptfoo")
    # A fresh directory prevents a failed run from publishing stale success reports.
    destination.mkdir(parents=True, exist_ok=False)
    if input_format == "promptfoo":
        imported = destination / "imported-bundle.json"
        code = import_promptfoo([str(source), "--out", str(imported)])
        if code:
            return 2
        source = imported
    args = ["check", str(source), "--out-dir", str(destination), "--max-regressions", limit]
    if require == "true":
        args.append("--require-supported-hypothesis")
    code = check(args)
    if code not in (0, 3, 4):
        return code
    result = json.loads((destination / "check.json").read_text(encoding="utf-8"))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            # Paths with line breaks cannot be encoded as single-line Action outputs.
            if "\n" in str(destination) or "\r" in str(destination):
                raise ValueError("Output path must not contain line breaks")
            output.write(f"report-directory={destination}\nregression-count={result['regression_count']}\npassed={str(result['passed']).lower()}\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            # Only numeric counts and a fixed reason: no prompts or conversations in job summaries.
            summary.write(f"### Prompt regression check\n\nRegression cases: {result['regression_count']}\n\nGate: {result['reason']}\n")
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(f"regression-action: {error}", file=sys.stderr)
        raise SystemExit(2)
