"""Run every first-party Python test suite from a source checkout."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRECTORIES = (
    REPOSITORY_ROOT / "packages" / "python" / "core" / "src",
    REPOSITORY_ROOT / "packages" / "python" / "plugin-sdk" / "src",
    REPOSITORY_ROOT / "plugins" / "official" / "promptfoo" / "src",
)
TEST_DIRECTORIES = (
    REPOSITORY_ROOT / "packages" / "python" / "core" / "tests",
    REPOSITORY_ROOT / "packages" / "python" / "plugin-sdk" / "tests",
    REPOSITORY_ROOT / "plugins" / "official" / "promptfoo" / "tests",
)


def main() -> int:
    for source in reversed(SOURCE_DIRECTORIES):
        if source.is_dir():
            sys.path.insert(0, str(source))

    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for tests in TEST_DIRECTORIES:
        if tests.is_dir():
            suite.addTests(
                loader.discover(
                    start_dir=str(tests),
                    pattern="test*.py",
                    top_level_dir=str(tests),
                )
            )

    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
