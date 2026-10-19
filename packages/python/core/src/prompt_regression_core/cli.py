"""Command-line interface for the deterministic diagnosis core."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile
from typing import Sequence

from .canonical import canonical_json
from .errors import PromptRegressionError
from .model import HypothesisStatus
from .parsing import load_bundle, loads_bundle
from .pipeline import DiagnosisPipeline
from .reporting import CsvReporter, MarkdownReporter
from .strategies import ENGINE_VERSION


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="prompt-regression",
        description="Diagnose paired prompt regressions with evidence-linked ablations.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {ENGINE_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser(
        "validate", help="Validate a canonical regression bundle without running diagnosis."
    )
    validate.add_argument("bundle", help="Bundle JSON path, or '-' to read standard input.")

    diagnose = subparsers.add_parser(
        "diagnose", help="Run the deterministic diagnosis pipeline."
    )
    diagnose.add_argument("bundle", help="Bundle JSON path, or '-' to read standard input.")
    diagnose.add_argument(
        "--out",
        type=Path,
        help="Write the report atomically to this path; defaults to standard output.",
    )
    diagnose.add_argument(
        "--compact", action="store_true", help="Emit compact canonical JSON."
    )
    diagnose.add_argument(
        "--format",
        choices=("json", "markdown", "csv"),
        default="json",
        help="Report format; defaults to machine-readable JSON.",
    )
    diagnose.add_argument(
        "--require-supported-hypothesis",
        action="store_true",
        help="Return exit code 4 when regressions exist but none pass the evidence gate.",
    )
    diagnose.add_argument("--max-regressions", type=_nonnegative, help="Return exit code 3 above this regression count, even if a cause is supported.")
    check = subparsers.add_parser("check", help="Write reports and a machine-readable CI gate result in one run.")
    check.add_argument("bundle", help="Bundle JSON path, or '-' for standard input.")
    check.add_argument("--out-dir", type=Path, required=True)
    check.add_argument("--max-regressions", type=_nonnegative, default=0)
    check.add_argument("--require-supported-hypothesis", action="store_true")
    return parser


def _nonnegative(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a nonnegative integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return parsed


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        bundle = (
            loads_bundle(sys.stdin.read(), source_label="stdin")
            if args.bundle == "-"
            else load_bundle(args.bundle)
        )
        if args.command == "validate":
            print(
                f"valid: {bundle.bundle_id} "
                f"({len(bundle.dataset.test_cases)} paired test cases)"
            )
            return 0

        report = DiagnosisPipeline().run(bundle)
        gate_code = 0
        gate_reason = "passed"
        if args.max_regressions is not None and len(report.regression.cases) > args.max_regressions:
            gate_code, gate_reason = 3, "regression_limit_exceeded"
        elif args.require_supported_hypothesis and report.regression.cases and not any(
            item.verification_status is HypothesisStatus.SUPPORTED for item in report.hypotheses
        ):
            gate_code, gate_reason = 4, "supported_hypothesis_required"
        if args.command == "check":
            for filename, payload in (
                ("report.json", canonical_json(report, pretty=True)),
                ("report.md", MarkdownReporter().render(report)),
                ("regressions.csv", CsvReporter().render(report)),
            ):
                _atomic_write(args.out_dir / filename, payload)
            summary = {
                "schema_version": "prompt-regression.check/v1",
                "passed": gate_code == 0, "exit_code": gate_code, "reason": gate_reason,
                "regression_count": len(report.regression.cases),
                "max_regressions": args.max_regressions,
                "report_id": report.report_id, "input_bundle_hash": report.input_bundle_hash,
            }
            _atomic_write(args.out_dir / "check.json", canonical_json(summary, pretty=True))
            print(canonical_json(summary))
            return gate_code
        if args.format != "json" and args.compact:
            print("error: --compact can only be used with --format json", file=sys.stderr)
            return 2
        payload = (
            MarkdownReporter().render(report)
            if args.format == "markdown"
            else CsvReporter().render(report)
            if args.format == "csv"
            else canonical_json(report, pretty=not args.compact)
        )
        if args.out is None:
            sys.stdout.write(payload)
            if args.compact:
                sys.stdout.write("\n")
        else:
            _atomic_write(args.out, payload + ("\n" if args.compact else ""))
            print(
                f"report: {args.out} | regressions={len(report.regression.cases)} "
                f"| hypotheses={len(report.hypotheses)} | evidence={len(report.evidence)}",
                file=sys.stderr,
            )

        return gate_code
    except (PromptRegressionError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
