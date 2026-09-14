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
from .reporting import MarkdownReporter


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="prompt-regression",
        description="Diagnose paired prompt regressions with evidence-linked ablations.",
    )
    parser.add_argument("--version", action="version", version="%(prog)s 0.1.0a1")
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
        choices=("json", "markdown"),
        default="json",
        help="Report format; defaults to machine-readable JSON.",
    )
    diagnose.add_argument(
        "--require-supported-hypothesis",
        action="store_true",
        help="Return exit code 4 when regressions exist but none pass the evidence gate.",
    )
    return parser


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
        if args.format == "markdown" and args.compact:
            print("error: --compact can only be used with --format json", file=sys.stderr)
            return 2
        payload = (
            MarkdownReporter().render(report)
            if args.format == "markdown"
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

        if args.require_supported_hypothesis and report.regression.cases:
            if not any(
                item.verification_status is HypothesisStatus.SUPPORTED
                for item in report.hypotheses
            ):
                return 4
        return 0
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
