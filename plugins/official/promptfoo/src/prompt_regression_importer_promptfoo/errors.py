"""Typed failures raised at the Promptfoo import boundary."""

from __future__ import annotations


class PromptfooImportError(ValueError):
    """Base error with a stable machine-readable code and JSON path."""

    code = "promptfoo_import_error"

    def __init__(self, message: str, *, path: str = "$") -> None:
        self.message = message
        self.path = path
        super().__init__(f"[{self.code}] {path}: {message}")


class PromptfooSchemaError(PromptfooImportError):
    """The import request or export does not match the supported shape."""

    code = "promptfoo_schema_error"


class PromptfooVersionError(PromptfooImportError):
    """The export is not exactly EvaluateSummary version 3."""

    code = "promptfoo_unsupported_version"


class PromptfooSelectionError(PromptfooImportError):
    """A prompt/provider slice cannot be selected without ambiguity."""

    code = "promptfoo_ambiguous_selection"


class PromptfooExecutionError(PromptfooImportError):
    """A selected row represents provider or evaluator execution failure."""

    code = "promptfoo_execution_error"


class PromptfooPairingError(PromptfooImportError):
    """Baseline and candidate rows are not the same controlled test set."""

    code = "promptfoo_pairing_error"


class PromptfooConfounderError(PromptfooImportError):
    """A non-prompt setting changed between baseline and candidate."""

    code = "promptfoo_confounder"
