"""Public API for the Prompt Regression Diagnosis plugin SDK."""

from .errors import (
    CoreCompatibilityError,
    CoreVersionUnavailableError,
    EntryPointResolutionError,
    InProcessPluginWarning,
    ManifestValidationError,
    PluginInterfaceError,
    PluginSdkError,
    PluginTrustRequiredError,
)
from .loader import InProcessTrust, LoadedPlugin, load_plugin
from .manifest import (
    MANIFEST_SCHEMA_VERSION,
    SDK_VERSION,
    CoreCompatibility,
    ParsedVersion,
    PluginEntryPoint,
    PluginKind,
    PluginManifest,
    ensure_core_compatible,
    installed_core_version,
    load_manifest,
    loads_manifest,
    parse_entry_point_target,
    parse_manifest,
    parse_version,
)

__version__ = SDK_VERSION

__all__ = [
    "CoreCompatibility",
    "CoreCompatibilityError",
    "CoreVersionUnavailableError",
    "EntryPointResolutionError",
    "InProcessPluginWarning",
    "InProcessTrust",
    "LoadedPlugin",
    "MANIFEST_SCHEMA_VERSION",
    "ManifestValidationError",
    "ParsedVersion",
    "PluginEntryPoint",
    "PluginInterfaceError",
    "PluginKind",
    "PluginManifest",
    "PluginSdkError",
    "PluginTrustRequiredError",
    "SDK_VERSION",
    "ensure_core_compatible",
    "installed_core_version",
    "load_manifest",
    "load_plugin",
    "loads_manifest",
    "parse_entry_point_target",
    "parse_manifest",
    "parse_version",
]
