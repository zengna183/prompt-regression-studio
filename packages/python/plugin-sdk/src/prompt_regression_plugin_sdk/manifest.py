"""Typed, data-only plugin manifest parsing and compatibility checks."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import StrEnum
from importlib import metadata
from pathlib import Path
from typing import Any, Mapping, Sequence

from .errors import (
    CoreCompatibilityError,
    CoreVersionUnavailableError,
    ManifestValidationError,
)


MANIFEST_SCHEMA_VERSION = "prompt-regression/plugin-manifest/v1alpha1"
SDK_VERSION = "0.1.0a1"

_PLUGIN_ID_PATTERN = re.compile(
    r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", re.ASCII
)
_VERSION_PATTERN = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:\.(0|[1-9][0-9]*))?"
    r"(?:(a|b|rc)(0|[1-9][0-9]*))?$",
    re.ASCII,
)
_MODULE_PATTERN = r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*"
_PUBLIC_ATTRIBUTE_PATTERN = (
    r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*"
)
_ENTRY_POINT_PATTERN = re.compile(
    rf"^(?P<module>{_MODULE_PATTERN}):(?P<attribute>{_PUBLIC_ATTRIBUTE_PATTERN})$",
    re.ASCII,
)


class PluginKind(StrEnum):
    """Public extension points supported by the v1alpha1 plugin contract."""

    EVAL_IMPORTER = "EvalImporter"
    TRACE_IMPORTER = "TraceImporter"
    PROVIDER_ADAPTER = "ProviderAdapter"
    EVALUATOR_ADAPTER = "EvaluatorAdapter"
    FAILURE_CLUSTERER = "FailureClusterer"
    PROMPT_PARSER = "PromptParser"
    SEMANTIC_DIFF_STRATEGY = "SemanticDiffStrategy"
    ROOT_CAUSE_STRATEGY = "RootCauseStrategy"
    ABLATION_STRATEGY = "AblationStrategy"
    EVIDENCE_SCORER = "EvidenceScorer"
    REPORTER = "Reporter"


@dataclass(frozen=True, slots=True)
class ParsedVersion:
    """Comparable subset of PEP 440 used by the alpha compatibility contract."""

    major: int
    minor: int
    patch: int
    prerelease: str | None = None
    prerelease_number: int = 0

    @property
    def sort_key(self) -> tuple[int, int, int, int, int]:
        stage_rank = {"a": 0, "b": 1, "rc": 2, None: 3}[self.prerelease]
        return (
            self.major,
            self.minor,
            self.patch,
            stage_rank,
            self.prerelease_number,
        )

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, ParsedVersion):
            return NotImplemented
        return self.sort_key < other.sort_key

    def __le__(self, other: object) -> bool:
        if not isinstance(other, ParsedVersion):
            return NotImplemented
        return self.sort_key <= other.sort_key

    def __gt__(self, other: object) -> bool:
        if not isinstance(other, ParsedVersion):
            return NotImplemented
        return self.sort_key > other.sort_key

    def __ge__(self, other: object) -> bool:
        if not isinstance(other, ParsedVersion):
            return NotImplemented
        return self.sort_key >= other.sort_key


def parse_version(value: str, *, field_name: str = "version") -> ParsedVersion:
    """Parse the intentionally small version subset used by this SDK.

    Supported examples are ``0.1``, ``0.1.0``, ``0.1.0a1``, ``1.2.0b2`` and
    ``2.0.0rc1``. Post/dev/local releases are intentionally rejected until the
    compatibility policy defines their ordering.
    """

    if not isinstance(value, str):
        raise ManifestValidationError(f"{field_name} must be a string")
    match = _VERSION_PATTERN.fullmatch(value)
    if match is None:
        raise ManifestValidationError(
            f"{field_name} must be a release such as 0.1.0 or 0.1.0a1"
        )
    major, minor, patch, prerelease, prerelease_number = match.groups()
    return ParsedVersion(
        major=int(major),
        minor=int(minor),
        patch=int(patch or "0"),
        prerelease=prerelease,
        prerelease_number=int(prerelease_number or "0"),
    )


def parse_entry_point_target(target: str) -> tuple[str, tuple[str, ...]]:
    """Validate and split a public ``module:attribute.path`` target.

    This function is data-only and never imports the declared module.
    """

    if not isinstance(target, str):
        raise ManifestValidationError("entry point target must be a string")
    match = _ENTRY_POINT_PATTERN.fullmatch(target)
    if match is None:
        raise ManifestValidationError(
            "entry point target must be a public module.path:attribute.path"
        )
    return match.group("module"), tuple(match.group("attribute").split("."))


@dataclass(frozen=True, slots=True)
class CoreCompatibility:
    """Half-open Core version range: minimum <= version < maximum."""

    minimum: str
    maximum_exclusive: str

    def __post_init__(self) -> None:
        minimum = parse_version(self.minimum, field_name="core_compatibility.minimum")
        maximum = parse_version(
            self.maximum_exclusive,
            field_name="core_compatibility.maximum_exclusive",
        )
        if minimum >= maximum:
            raise ManifestValidationError(
                "core_compatibility.minimum must be lower than maximum_exclusive"
            )

    def supports(self, version: str) -> bool:
        parsed = parse_version(version, field_name="core_version")
        return (
            parse_version(self.minimum) <= parsed
            and parsed < parse_version(self.maximum_exclusive)
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> CoreCompatibility:
        _require_mapping(value, "core_compatibility")
        _require_exact_keys(
            value,
            required={"minimum", "maximum_exclusive"},
            optional=set(),
            field_name="core_compatibility",
        )
        return cls(
            minimum=_require_string(value["minimum"], "core_compatibility.minimum"),
            maximum_exclusive=_require_string(
                value["maximum_exclusive"],
                "core_compatibility.maximum_exclusive",
            ),
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "minimum": self.minimum,
            "maximum_exclusive": self.maximum_exclusive,
        }


@dataclass(frozen=True, slots=True)
class PluginEntryPoint:
    """One declared plugin object and the Core protocol it implements."""

    kind: PluginKind
    target: str

    def __post_init__(self) -> None:
        if not isinstance(self.kind, PluginKind):
            raise ManifestValidationError("entry point kind must be a PluginKind")
        parse_entry_point_target(self.target)

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any], *, index: int) -> PluginEntryPoint:
        field_name = f"entry_points[{index}]"
        _require_mapping(value, field_name)
        _require_exact_keys(
            value,
            required={"kind", "target"},
            optional=set(),
            field_name=field_name,
        )
        raw_kind = _require_string(value["kind"], f"{field_name}.kind")
        try:
            kind = PluginKind(raw_kind)
        except ValueError as exc:
            supported = ", ".join(item.value for item in PluginKind)
            raise ManifestValidationError(
                f"{field_name}.kind must be one of: {supported}"
            ) from exc
        return cls(
            kind=kind,
            target=_require_string(value["target"], f"{field_name}.target"),
        )

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind.value, "target": self.target}


@dataclass(frozen=True, slots=True)
class PluginManifest:
    """Immutable public description of one installable plugin distribution."""

    schema_version: str
    plugin_id: str
    name: str
    version: str
    core_compatibility: CoreCompatibility
    entry_points: tuple[PluginEntryPoint, ...]
    description: str = ""
    homepage: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.schema_version, str):
            raise ManifestValidationError("schema_version must be a string")
        if self.schema_version != MANIFEST_SCHEMA_VERSION:
            raise ManifestValidationError(
                "schema_version must be " f"{MANIFEST_SCHEMA_VERSION!r}"
            )
        if not isinstance(self.plugin_id, str) or _PLUGIN_ID_PATTERN.fullmatch(
            self.plugin_id
        ) is None:
            raise ManifestValidationError(
                "plugin_id must be lower-case and may contain '.', '_' or '-' separators"
            )
        _validate_nonempty_text(self.name, "name")
        parse_version(self.version, field_name="version")
        if not isinstance(self.core_compatibility, CoreCompatibility):
            raise ManifestValidationError(
                "core_compatibility must be a CoreCompatibility object"
            )
        if not isinstance(self.entry_points, tuple):
            raise ManifestValidationError("entry_points must be an immutable tuple")
        if not self.entry_points:
            raise ManifestValidationError("entry_points must contain at least one item")
        if any(not isinstance(item, PluginEntryPoint) for item in self.entry_points):
            raise ManifestValidationError(
                "entry_points must contain only PluginEntryPoint objects"
            )
        kinds = [item.kind for item in self.entry_points]
        if len(kinds) != len(set(kinds)):
            raise ManifestValidationError(
                "entry_points may declare each PluginKind only once"
            )
        if not isinstance(self.description, str):
            raise ManifestValidationError("description must be a string")
        if self.homepage is not None:
            if not isinstance(self.homepage, str) or not self.homepage.startswith(
                ("https://", "http://")
            ):
                raise ManifestValidationError(
                    "homepage must be an http:// or https:// URL"
                )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> PluginManifest:
        _require_mapping(value, "manifest")
        _require_exact_keys(
            value,
            required={
                "schema_version",
                "plugin_id",
                "name",
                "version",
                "core_compatibility",
                "entry_points",
            },
            optional={"description", "homepage"},
            field_name="manifest",
        )
        raw_entry_points = value["entry_points"]
        if not isinstance(raw_entry_points, Sequence) or isinstance(
            raw_entry_points, (str, bytes, bytearray)
        ):
            raise ManifestValidationError("entry_points must be an array")
        compatibility_value = value["core_compatibility"]
        _require_mapping(compatibility_value, "core_compatibility")
        return cls(
            schema_version=_require_string(value["schema_version"], "schema_version"),
            plugin_id=_require_string(value["plugin_id"], "plugin_id"),
            name=_require_string(value["name"], "name"),
            version=_require_string(value["version"], "version"),
            description=_require_string(value.get("description", ""), "description"),
            homepage=_optional_string(value.get("homepage"), "homepage"),
            core_compatibility=CoreCompatibility.from_mapping(compatibility_value),
            entry_points=tuple(
                PluginEntryPoint.from_mapping(item, index=index)
                for index, item in enumerate(raw_entry_points)
            ),
        )

    def entry_point_for(self, kind: PluginKind) -> PluginEntryPoint:
        if not isinstance(kind, PluginKind):
            raise ManifestValidationError("kind must be a PluginKind")
        for entry_point in self.entry_points:
            if entry_point.kind is kind:
                return entry_point
        raise ManifestValidationError(
            f"plugin {self.plugin_id!r} does not declare {kind.value}"
        )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "schema_version": self.schema_version,
            "plugin_id": self.plugin_id,
            "name": self.name,
            "version": self.version,
            "core_compatibility": self.core_compatibility.to_dict(),
            "entry_points": [item.to_dict() for item in self.entry_points],
        }
        if self.description:
            result["description"] = self.description
        if self.homepage is not None:
            result["homepage"] = self.homepage
        return result


def parse_manifest(value: Mapping[str, Any]) -> PluginManifest:
    """Parse a mapping without discovering or importing plugin code."""

    return PluginManifest.from_mapping(value)


def loads_manifest(value: str | bytes | bytearray) -> PluginManifest:
    """Parse manifest JSON without discovering or importing plugin code."""

    try:
        decoded = json.loads(
            value,
            object_pairs_hook=_reject_duplicate_object_keys,
            parse_constant=_reject_non_finite_json_number,
        )
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ManifestValidationError(f"manifest is not valid JSON: {exc}") from exc
    _require_mapping(decoded, "manifest")
    return parse_manifest(decoded)


def load_manifest(path: str | Path) -> PluginManifest:
    """Read one explicit manifest path; no package discovery is performed."""

    manifest_path = Path(path)
    try:
        value = manifest_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ManifestValidationError(
            f"cannot read manifest {manifest_path}: {exc}"
        ) from exc
    return loads_manifest(value)


def installed_core_version() -> str:
    """Return installed Core package metadata without importing a plugin."""

    try:
        return metadata.version("prompt-regression-core")
    except metadata.PackageNotFoundError as exc:
        raise CoreVersionUnavailableError(
            "prompt-regression-core distribution metadata was not found; "
            "pass core_version explicitly in source-tree tooling"
        ) from exc


def ensure_core_compatible(
    manifest: PluginManifest, *, core_version: str | None = None
) -> str:
    """Validate the active Core version and return the resolved version."""

    if not isinstance(manifest, PluginManifest):
        raise ManifestValidationError("manifest must be a PluginManifest")
    resolved = core_version if core_version is not None else installed_core_version()
    if not manifest.core_compatibility.supports(resolved):
        bounds = manifest.core_compatibility
        raise CoreCompatibilityError(
            f"plugin {manifest.plugin_id!r} supports Core >= {bounds.minimum} and "
            f"< {bounds.maximum_exclusive}; active Core is {resolved}"
        )
    return resolved


def _require_mapping(value: Any, field_name: str) -> None:
    if not isinstance(value, Mapping):
        raise ManifestValidationError(f"{field_name} must be an object")


def _require_exact_keys(
    value: Mapping[str, Any],
    *,
    required: set[str],
    optional: set[str],
    field_name: str,
) -> None:
    keys = set(value)
    if any(not isinstance(key, str) for key in keys):
        raise ManifestValidationError(f"{field_name} field names must be strings")
    missing = sorted(required - keys)
    unknown = sorted(keys - required - optional)
    if missing:
        raise ManifestValidationError(
            f"{field_name} is missing required field(s): {', '.join(missing)}"
        )
    if unknown:
        raise ManifestValidationError(
            f"{field_name} contains unknown field(s): {', '.join(unknown)}"
        )


def _require_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ManifestValidationError(f"{field_name} must be a string")
    return value


def _optional_string(value: Any, field_name: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field_name)


def _validate_nonempty_text(value: Any, field_name: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ManifestValidationError(f"{field_name} must be a non-empty string")


def _reject_duplicate_object_keys(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    """Build a JSON object while rejecting ambiguous duplicate members."""

    result: dict[str, Any] = {}
    for key, item in pairs:
        if key in result:
            raise ManifestValidationError(
                f"manifest JSON contains duplicate object key: {key!r}"
            )
        result[key] = item
    return result


def _reject_non_finite_json_number(token: str) -> Any:
    """Reject Python JSON extensions that are invalid in RFC 8259 JSON."""

    raise ManifestValidationError(
        f"manifest JSON contains non-finite number: {token}"
    )
