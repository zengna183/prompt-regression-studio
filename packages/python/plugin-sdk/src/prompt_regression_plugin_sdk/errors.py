"""Errors and warnings raised by the plugin SDK."""

from __future__ import annotations


class PluginSdkError(Exception):
    """Base class for all plugin SDK failures."""


class ManifestValidationError(PluginSdkError, ValueError):
    """A plugin manifest is malformed or violates the public contract."""


class CoreCompatibilityError(PluginSdkError):
    """The selected plugin does not support the active Core version."""


class CoreVersionUnavailableError(PluginSdkError):
    """The installed Core distribution version cannot be determined."""


class PluginTrustRequiredError(PluginSdkError):
    """The caller did not acknowledge in-process code execution."""


class EntryPointResolutionError(PluginSdkError):
    """A declared entry point cannot be imported or resolved."""


class PluginInterfaceError(PluginSdkError, TypeError):
    """A loaded object does not implement its declared Core protocol."""


class InProcessPluginWarning(UserWarning):
    """Loading a plugin executes third-party code without sandboxing."""
