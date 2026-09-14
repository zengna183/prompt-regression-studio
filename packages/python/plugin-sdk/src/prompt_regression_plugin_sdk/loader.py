"""Explicit, trust-gated loading of one declared plugin object."""

from __future__ import annotations

import importlib
import inspect
import warnings
from dataclasses import dataclass
from enum import StrEnum
from types import ModuleType
from typing import Any

from prompt_regression_core import ports

from .errors import (
    EntryPointResolutionError,
    InProcessPluginWarning,
    PluginInterfaceError,
    PluginTrustRequiredError,
)
from .manifest import (
    PluginKind,
    PluginManifest,
    ensure_core_compatible,
    parse_entry_point_target,
)


class InProcessTrust(StrEnum):
    """Explicit policy decision required before importing third-party code."""

    DENY = "deny"
    ACKNOWLEDGED = "acknowledged"


@dataclass(frozen=True, slots=True)
class LoadedPlugin:
    """A resolved object paired with its verified declaration."""

    plugin_id: str
    plugin_version: str
    kind: PluginKind
    target: str
    instance: Any


_INTERFACE_BY_KIND: dict[PluginKind, type[Any]] = {
    PluginKind.EVAL_IMPORTER: ports.EvalImporter,
    PluginKind.TRACE_IMPORTER: ports.TraceImporter,
    PluginKind.PROVIDER_ADAPTER: ports.ProviderAdapter,
    PluginKind.EVALUATOR_ADAPTER: ports.EvaluatorAdapter,
    PluginKind.FAILURE_CLUSTERER: ports.FailureClusterer,
    PluginKind.PROMPT_PARSER: ports.PromptParser,
    PluginKind.SEMANTIC_DIFF_STRATEGY: ports.SemanticDiffStrategy,
    PluginKind.ROOT_CAUSE_STRATEGY: ports.RootCauseStrategy,
    PluginKind.ABLATION_STRATEGY: ports.AblationStrategy,
    PluginKind.EVIDENCE_SCORER: ports.EvidenceScorer,
    PluginKind.REPORTER: ports.Reporter,
}

_REQUIRED_METHODS_BY_KIND: dict[PluginKind, tuple[str, ...]] = {
    PluginKind.EVAL_IMPORTER: ("import_bundle",),
    PluginKind.TRACE_IMPORTER: ("import_traces",),
    PluginKind.PROVIDER_ADAPTER: ("generate",),
    PluginKind.EVALUATOR_ADAPTER: ("evaluate",),
    PluginKind.FAILURE_CLUSTERER: ("cluster",),
    PluginKind.PROMPT_PARSER: ("parse",),
    PluginKind.SEMANTIC_DIFF_STRATEGY: ("diff",),
    PluginKind.ROOT_CAUSE_STRATEGY: ("propose",),
    PluginKind.ABLATION_STRATEGY: ("plan",),
    PluginKind.EVIDENCE_SCORER: ("score",),
    PluginKind.REPORTER: ("render",),
}

_DESCRIBED_STRATEGY_KINDS = frozenset(
    {
        PluginKind.FAILURE_CLUSTERER,
        PluginKind.PROMPT_PARSER,
        PluginKind.SEMANTIC_DIFF_STRATEGY,
        PluginKind.ROOT_CAUSE_STRATEGY,
        PluginKind.ABLATION_STRATEGY,
        PluginKind.EVIDENCE_SCORER,
        PluginKind.REPORTER,
    }
)


def load_plugin(
    manifest: PluginManifest,
    kind: PluginKind,
    *,
    core_version: str | None = None,
    trust: InProcessTrust = InProcessTrust.DENY,
) -> LoadedPlugin:
    """Load and structurally validate one explicitly selected plugin object.

    Importing a module executes its top-level code. The default trust policy is
    therefore deny. Callers must acknowledge this boundary for every load call.
    The target must be an already-created object instance; implicit factories and
    constructors are never called.
    """

    if not isinstance(kind, PluginKind):
        raise PluginInterfaceError("kind must be a PluginKind")
    entry_point = manifest.entry_point_for(kind)
    ensure_core_compatible(manifest, core_version=core_version)
    if trust is not InProcessTrust.ACKNOWLEDGED:
        raise PluginTrustRequiredError(
            "in-process plugin loading executes third-party code without a sandbox; "
            "pass trust=InProcessTrust.ACKNOWLEDGED only after reviewing the plugin"
        )

    warnings.warn(
        f"loading {manifest.plugin_id!r} in process executes third-party code "
        "without sandboxing",
        InProcessPluginWarning,
        stacklevel=2,
    )
    module_name, attribute_path = parse_entry_point_target(entry_point.target)
    instance = _resolve_object(module_name, attribute_path, entry_point.target)
    _validate_interface(instance, kind, entry_point.target)
    return LoadedPlugin(
        plugin_id=manifest.plugin_id,
        plugin_version=manifest.version,
        kind=kind,
        target=entry_point.target,
        instance=instance,
    )


def _resolve_object(
    module_name: str, attribute_path: tuple[str, ...], target: str
) -> Any:
    try:
        current: Any = importlib.import_module(module_name)
    except Exception as exc:
        raise EntryPointResolutionError(
            f"cannot import entry point module {module_name!r} for {target!r}: {exc}"
        ) from exc

    for attribute in attribute_path:
        try:
            current = getattr(current, attribute)
        except AttributeError as exc:
            raise EntryPointResolutionError(
                f"entry point {target!r} has no public attribute {attribute!r}"
            ) from exc
    return current


def _validate_interface(instance: Any, kind: PluginKind, target: str) -> None:
    if inspect.isclass(instance) or inspect.isfunction(instance) or isinstance(
        instance, ModuleType
    ):
        raise PluginInterfaceError(
            f"entry point {target!r} must export an object instance, not a class, "
            "function, or module"
        )
    protocol = _INTERFACE_BY_KIND[kind]
    if not isinstance(instance, protocol):
        raise PluginInterfaceError(
            f"entry point {target!r} does not implement {kind.value}"
        )
    missing_methods = [
        name
        for name in _REQUIRED_METHODS_BY_KIND[kind]
        if not callable(getattr(instance, name, None))
    ]
    if missing_methods:
        raise PluginInterfaceError(
            f"entry point {target!r} has non-callable method(s) required by "
            f"{kind.value}: {', '.join(missing_methods)}"
        )
    if kind in _DESCRIBED_STRATEGY_KINDS:
        invalid_descriptors = [
            name
            for name in ("name", "version")
            if not isinstance(getattr(instance, name, None), str)
            or not getattr(instance, name).strip()
        ]
        if invalid_descriptors:
            raise PluginInterfaceError(
                f"entry point {target!r} must expose non-empty text attribute(s): "
                f"{', '.join(invalid_descriptors)}"
            )
