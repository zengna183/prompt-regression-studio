from contextlib import redirect_stdout, redirect_stderr
from dataclasses import replace
from io import StringIO
import csv
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prompt_regression_core import DiagnosisPipeline, load_bundle
from prompt_regression_core.cli import main
from prompt_regression_core.reporting import CsvReporter


ROOT = Path(__file__).resolve().parents[4]
EXAMPLE = ROOT / "examples/missing-information-regression/regression-bundle.json"


class CliExportsTests(unittest.TestCase):
    def test_supported_cause_does_not_make_regressed_prompt_pass_ci(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(StringIO()):
            code = main(["check", str(EXAMPLE), "--out-dir", directory])
            self.assertEqual(code, 3)
            summary = json.loads((Path(directory) / "check.json").read_text())
            report = json.loads((Path(directory) / "report.json").read_text())
            self.assertFalse(summary["passed"])
            self.assertEqual(summary["reason"], "regression_limit_exceeded")
            self.assertEqual(summary["report_id"], report["report_id"])
            self.assertEqual(summary["regression_count"], len(report["regression"]["cases"]))
            self.assertTrue((Path(directory) / "report.md").is_file())
            rows = list(csv.DictReader((Path(directory) / "regressions.csv").open(newline="")))
            self.assertEqual(len(rows), summary["regression_count"])

    def test_gate_tolerance_and_unverified_cause_have_distinct_outcomes(self):
        report = DiagnosisPipeline().run(load_bundle(EXAMPLE))
        pending = replace(report, hypotheses=())
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(StringIO()):
            self.assertEqual(main(["check", str(EXAMPLE), "--out-dir", directory, "--max-regressions", "100"]), 0)
            with patch("prompt_regression_core.cli.DiagnosisPipeline.run", return_value=pending):
                self.assertEqual(main(["check", str(EXAMPLE), "--out-dir", directory, "--max-regressions", "100", "--require-supported-hypothesis"]), 4)
        clean = replace(report, regression=replace(report.regression, cases=()))
        with tempfile.TemporaryDirectory() as directory, redirect_stdout(StringIO()), patch("prompt_regression_core.cli.DiagnosisPipeline.run", return_value=clean):
            self.assertEqual(main(["check", str(EXAMPLE), "--out-dir", directory]), 0)

    def test_csv_quotes_formulas_but_keeps_negative_delta_numeric(self):
        report = DiagnosisPipeline().run(load_bundle(EXAMPLE))
        case = replace(report.regression.cases[0], test_case_id='=HYPERLINK("evil")', primary_metric="@metric", metric_deltas={"@metric": -0.8})
        report = replace(report, regression=replace(report.regression, cases=(case,)))
        row = next(csv.DictReader(StringIO(CsvReporter().render(report))))
        self.assertTrue(row["test_case_id"].startswith("'="))
        self.assertEqual(row["primary_metric"], "'@metric")
        self.assertEqual(float(row["primary_delta"]), -0.8)

    def test_invalid_input_is_error_instead_of_a_successful_gate(self):
        with tempfile.TemporaryDirectory() as directory, redirect_stderr(StringIO()):
            self.assertEqual(main(["check", str(Path(directory) / "missing"), "--out-dir", directory]), 2)
            self.assertFalse((Path(directory) / "check.json").exists())

    def test_csv_cli_supports_stdin_and_rejects_compact(self):
        output = StringIO()
        with patch("sys.stdin", StringIO(EXAMPLE.read_text(encoding="utf-8"))), redirect_stdout(output):
            self.assertEqual(main(["diagnose", "-", "--format", "csv"]), 0)
        self.assertTrue(output.getvalue().startswith("report_id,"))
        with redirect_stderr(StringIO()):
            self.assertEqual(main(["diagnose", str(EXAMPLE), "--format", "csv", "--compact"]), 2)
