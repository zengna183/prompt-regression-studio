"""Command-line boundary for converting Promptfoo imports to Core bundles."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile
from typing import Sequence

from prompt_regression_core import canonical_json

from .errors import PromptfooImportError
from .importer import ADAPTER_VERSION, PromptfooImporter


EXIT_OK = 0
EXIT_USAGE = 2
EXIT_IMPORT_ERROR = 3
EXIT_OUTPUT_ERROR = 4


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="prompt-regression-import-promptfoo",
        description=(
            "Convert a strict paired Promptfoo EvaluateSummaryV3 import request "
            "to a canonical Prompt Regression bundle."
        ),
    )
    parser.add_argument(
        "input",
        help="Import-request JSON file, or '-' to read UTF-8 JSON from stdin.",
    )
    parser.add_argument(
        "--out",
        default="-",
        help="Canonical bundle path, or '-' for stdout (default: '-').",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Emit canonical compact JSON instead of indented JSON.",
    )
    parser.add_argument("--version", action="version", version=ADAPTER_VERSION)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a stable process status code."""

    args = build_parser().parse_args(argv)
    importer = PromptfooImporter()
    try:
        if args.input == "-":
            bundle = importer.loads(sys.stdin.read())
        else:
            bundle = importer.load(args.input)
    except PromptfooImportError as error:
        print(f"promptfoo-import: {error}", file=sys.stderr)
        return EXIT_IMPORT_ERROR
    except OSError as error:
        print(f"promptfoo-import: input I/O error: {error}", file=sys.stderr)
        return EXIT_IMPORT_ERROR

    payload = canonical_json(bundle, pretty=not args.compact)
    if not payload.endswith("\n"):
        payload += "\n"
    try:
        if args.out == "-":
            sys.stdout.write(payload)
            sys.stdout.flush()
        else:
            _atomic_write_text(Path(args.out), payload)
    except BrokenPipeError:
        return EXIT_OK
    except OSError as error:
        print(f"promptfoo-import: output I/O error: {error}", file=sys.stderr)
        return EXIT_OUTPUT_ERROR
    return EXIT_OK


def _atomic_write_text(destination: Path, payload: str) -> None:
    """Replace a bundle only after a complete same-directory write and fsync."""

    parent = destination.parent
    if not parent.exists():
        raise FileNotFoundError(f"output directory does not exist: {parent}")
    if not parent.is_dir():
        raise NotADirectoryError(f"output parent is not a directory: {parent}")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=parent,
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def entrypoint() -> None:
    """Console-script wrapper."""

    raise SystemExit(main())


__all__ = [
    "EXIT_IMPORT_ERROR",
    "EXIT_OK",
    "EXIT_OUTPUT_ERROR",
    "EXIT_USAGE",
    "build_parser",
    "entrypoint",
    "main",
]
