"""Explicit errors raised at the stable-core boundary."""


class PromptRegressionError(Exception):
    """Base class for all expected core errors."""


class BundleValidationError(PromptRegressionError, ValueError):
    """The canonical input bundle violates a contract or domain invariant."""


class PipelineInvariantError(PromptRegressionError, RuntimeError):
    """A pipeline component returned data that cannot be safely composed."""


class MissingAblationFixtureError(PromptRegressionError, LookupError):
    """A fixture-backed ablation was requested without an explicit fixture."""
