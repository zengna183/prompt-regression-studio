"""Public API for the official Promptfoo importer."""

from .errors import (
    PromptfooConfounderError,
    PromptfooExecutionError,
    PromptfooImportError,
    PromptfooPairingError,
    PromptfooSchemaError,
    PromptfooSelectionError,
    PromptfooVersionError,
)
from .importer import (
    ADAPTER_NAME,
    ADAPTER_VERSION,
    IMPORT_SCHEMA_VERSION,
    OVERALL_METRIC_KEY,
    PROMPTFOO_SUMMARY_VERSION,
    PromptfooImporter,
)

# Plugin manifests point to an already-created object. The SDK deliberately
# never calls implicit factories or constructors when loading third-party code.
plugin = PromptfooImporter()

__all__ = [
    "ADAPTER_NAME",
    "ADAPTER_VERSION",
    "IMPORT_SCHEMA_VERSION",
    "OVERALL_METRIC_KEY",
    "PROMPTFOO_SUMMARY_VERSION",
    "PromptfooConfounderError",
    "PromptfooExecutionError",
    "PromptfooImportError",
    "PromptfooImporter",
    "PromptfooPairingError",
    "PromptfooSchemaError",
    "PromptfooSelectionError",
    "PromptfooVersionError",
    "plugin",
]
