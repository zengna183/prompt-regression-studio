from __future__ import annotations

import json
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

from prompt_regression_plugin_sdk import (
    MANIFEST_SCHEMA_VERSION,
    InProcessPluginWarning,
    InProcessTrust,
    PluginInterfaceError,
    PluginKind,
    PluginTrustRequiredError,
    ensure_core_compatible,
    load_plugin,
    loads_manifest,
)


def manifest_json(module_name: str) -> str:
    return json.dumps(
        {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "plugin_id": f"tests.{module_name.replace('_', '-')}",
            "name": "Test plugin",
            "version": "0.1.0a1",
            "core_compatibility": {
                "minimum": "0.1.0a1",
                "maximum_exclusive": "0.2.0",
            },
            "entry_points": [
                {"kind": "EvalImporter", "target": f"{module_name}:plugin"}
            ],
        }
    )


class LoaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary_directory.name)
        sys.path.insert(0, str(self.directory))

    def tearDown(self) -> None:
        sys.path.remove(str(self.directory))
        for module_name in (
            "probe_validation_only",
            "probe_trust_guard",
            "valid_importer_plugin",
            "invalid_importer_plugin",
        ):
            sys.modules.pop(module_name, None)
        self.temporary_directory.cleanup()

    def write_module(self, module_name: str, content: str) -> None:
        (self.directory / f"{module_name}.py").write_text(content, encoding="utf-8")

    def test_validation_and_compatibility_do_not_import_plugin(self) -> None:
        self.write_module(
            "probe_validation_only",
            "raise RuntimeError('manifest validation imported plugin code')\n",
        )
        manifest = loads_manifest(manifest_json("probe_validation_only"))

        ensure_core_compatible(manifest, core_version="0.1.0a1")

        self.assertNotIn("probe_validation_only", sys.modules)

    def test_default_trust_policy_blocks_before_import(self) -> None:
        marker = self.directory / "imported.txt"
        self.write_module(
            "probe_trust_guard",
            f"from pathlib import Path\nPath({str(marker)!r}).write_text('yes')\n"
            "plugin = object()\n",
        )
        manifest = loads_manifest(manifest_json("probe_trust_guard"))

        with self.assertRaises(PluginTrustRequiredError):
            load_plugin(
                manifest,
                PluginKind.EVAL_IMPORTER,
                core_version="0.1.0a1",
            )

        self.assertFalse(marker.exists())
        self.assertNotIn("probe_trust_guard", sys.modules)

    def test_explicit_load_accepts_structural_protocol_instance(self) -> None:
        self.write_module(
            "valid_importer_plugin",
            "class Importer:\n"
            "    def import_bundle(self, source):\n"
            "        return source\n"
            "plugin = Importer()\n",
        )
        manifest = loads_manifest(manifest_json("valid_importer_plugin"))

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            loaded = load_plugin(
                manifest,
                PluginKind.EVAL_IMPORTER,
                core_version="0.1.0a1",
                trust=InProcessTrust.ACKNOWLEDGED,
            )

        self.assertEqual(loaded.instance.import_bundle("bundle"), "bundle")
        self.assertTrue(
            any(item.category is InProcessPluginWarning for item in caught)
        )

    def test_explicit_load_rejects_interface_mismatch(self) -> None:
        self.write_module("invalid_importer_plugin", "plugin = object()\n")
        manifest = loads_manifest(manifest_json("invalid_importer_plugin"))

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", InProcessPluginWarning)
            with self.assertRaisesRegex(
                PluginInterfaceError, "does not implement EvalImporter"
            ):
                load_plugin(
                    manifest,
                    PluginKind.EVAL_IMPORTER,
                    core_version="0.1.0a1",
                    trust=InProcessTrust.ACKNOWLEDGED,
                )


if __name__ == "__main__":
    unittest.main()
