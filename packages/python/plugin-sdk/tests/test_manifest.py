from __future__ import annotations

import json
import unittest

from prompt_regression_plugin_sdk import (
    MANIFEST_SCHEMA_VERSION,
    CoreCompatibilityError,
    ManifestValidationError,
    PluginKind,
    ensure_core_compatible,
    loads_manifest,
)


def valid_manifest_data() -> dict[str, object]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "plugin_id": "acme.promptfoo-importer",
        "name": "Acme Promptfoo Importer",
        "version": "0.1.0a1",
        "description": "Imports approved evaluation bundles.",
        "homepage": "https://example.com/plugin",
        "core_compatibility": {
            "minimum": "0.1.0a1",
            "maximum_exclusive": "0.2.0",
        },
        "entry_points": [
            {
                "kind": "EvalImporter",
                "target": "acme_promptfoo_importer:plugin",
            }
        ],
    }


class ManifestTests(unittest.TestCase):
    def test_plugin_kind_contract_contains_all_public_extension_points(self) -> None:
        self.assertEqual(
            {kind.value for kind in PluginKind},
            {
                "EvalImporter",
                "TraceImporter",
                "ProviderAdapter",
                "EvaluatorAdapter",
                "FailureClusterer",
                "PromptParser",
                "SemanticDiffStrategy",
                "RootCauseStrategy",
                "AblationStrategy",
                "EvidenceScorer",
                "Reporter",
            },
        )

    def test_valid_manifest_is_typed_and_round_trips(self) -> None:
        manifest = loads_manifest(json.dumps(valid_manifest_data()))

        self.assertEqual(manifest.plugin_id, "acme.promptfoo-importer")
        self.assertEqual(manifest.entry_points[0].kind, PluginKind.EVAL_IMPORTER)
        self.assertEqual(manifest.to_dict(), valid_manifest_data())

    def test_manifest_rejects_unknown_fields(self) -> None:
        value = valid_manifest_data()
        value["run_this"] = "do-not-execute"

        with self.assertRaisesRegex(ManifestValidationError, "unknown field"):
            loads_manifest(json.dumps(value))

    def test_manifest_json_rejects_duplicate_keys_at_any_depth(self) -> None:
        top_level_duplicate = (
            '{"schema_version":"prompt-regression/plugin-manifest/v1alpha1",'
            '"schema_version":"prompt-regression/plugin-manifest/v1alpha1"}'
        )
        nested_duplicate = (
            '{"core_compatibility":{"minimum":"0.1.0a1",'
            '"minimum":"0.1.0a1"}}'
        )

        for raw_json in (top_level_duplicate, nested_duplicate):
            with self.subTest(raw_json=raw_json):
                with self.assertRaisesRegex(
                    ManifestValidationError, "duplicate object key"
                ):
                    loads_manifest(raw_json)

    def test_manifest_json_rejects_non_finite_numbers(self) -> None:
        for token in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(token=token):
                raw_json = (
                    '{"schema_version":"prompt-regression/plugin-manifest/v1alpha1",'
                    f'"not_a_json_number":{token}'
                    "}"
                )
                with self.assertRaisesRegex(
                    ManifestValidationError, "non-finite number"
                ):
                    loads_manifest(raw_json)

    def test_manifest_rejects_invalid_id_kind_target_and_duplicate_kind(self) -> None:
        cases: list[tuple[str, object, str]] = [
            ("plugin_id", "Acme Plugin", "plugin_id"),
            (
                "entry_points",
                [{"kind": "UnknownAdapter", "target": "safe_module:plugin"}],
                "must be one of",
            ),
            (
                "entry_points",
                [{"kind": "EvalImporter", "target": "safe_module:plugin()"}],
                "module.path:attribute.path",
            ),
            (
                "entry_points",
                [
                    {"kind": "EvalImporter", "target": "safe_module:first"},
                    {"kind": "EvalImporter", "target": "safe_module:second"},
                ],
                "only once",
            ),
        ]

        for field, replacement, message in cases:
            with self.subTest(field=field, replacement=replacement):
                value = valid_manifest_data()
                value[field] = replacement
                with self.assertRaisesRegex(ManifestValidationError, message):
                    loads_manifest(json.dumps(value))

    def test_manifest_rejects_inverted_compatibility_range(self) -> None:
        value = valid_manifest_data()
        value["core_compatibility"] = {
            "minimum": "0.2.0",
            "maximum_exclusive": "0.1.0",
        }

        with self.assertRaisesRegex(ManifestValidationError, "must be lower"):
            loads_manifest(json.dumps(value))

    def test_core_compatibility_uses_half_open_range(self) -> None:
        manifest = loads_manifest(json.dumps(valid_manifest_data()))

        self.assertEqual(
            ensure_core_compatible(manifest, core_version="0.1.0a1"),
            "0.1.0a1",
        )
        self.assertEqual(
            ensure_core_compatible(manifest, core_version="0.1.9"),
            "0.1.9",
        )
        for version in ("0.1.0a0", "0.2", "1.0.0"):
            with self.subTest(version=version):
                with self.assertRaises(CoreCompatibilityError):
                    ensure_core_compatible(manifest, core_version=version)


if __name__ == "__main__":
    unittest.main()
