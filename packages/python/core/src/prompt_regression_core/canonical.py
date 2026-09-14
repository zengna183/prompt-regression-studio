"""Canonical JSON and stable identifiers used for reproducible reports."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from enum import Enum
from hashlib import sha256
import json
import math
from pathlib import Path
from typing import Any, Mapping


def to_primitive(value: Any) -> Any:
    """Convert domain values to JSON-compatible values without hiding errors."""

    if is_dataclass(value):
        return {key: to_primitive(item) for key, item in asdict(value).items()}
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        return {str(key): to_primitive(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [to_primitive(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Canonical JSON does not permit NaN or infinity")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"Unsupported canonical value: {type(value).__name__}")


def canonical_json(value: Any, *, pretty: bool = False) -> str:
    """Serialize with stable key ordering and no platform-dependent whitespace."""

    primitive = to_primitive(value)
    if pretty:
        return json.dumps(
            primitive,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            allow_nan=False,
        ) + "\n"
    return json.dumps(
        primitive,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    )


def content_hash(value: Any) -> str:
    """Return a full SHA-256 hash of a canonical value."""

    return sha256(canonical_json(value).encode("utf-8")).hexdigest()


def stable_id(prefix: str, value: Any) -> str:
    """Create a readable deterministic identifier from immutable inputs."""

    return f"{prefix}_{content_hash(value)[:20]}"
