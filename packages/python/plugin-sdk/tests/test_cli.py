from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prompt_regression_plugin_sdk.cli import main
from test_manifest import valid_manifest_data


class PluginCliTests(unittest.TestCase):
    def test_manifest_inspection_never_imports_declared_code(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plugin.json"
            path.write_text(json.dumps(valid_manifest_data()), encoding="utf-8")
            output = StringIO()
            with redirect_stdout(output), patch("prompt_regression_plugin_sdk.loader.importlib.import_module") as importer:
                self.assertEqual(main(["validate", str(path), "--core-version", "0.1.0a2"]), 0)
                importer.assert_not_called()
            self.assertFalse(json.loads(output.getvalue())["loaded"])
            with redirect_stderr(StringIO()), patch("prompt_regression_plugin_sdk.loader.importlib.import_module") as importer:
                self.assertEqual(main(["validate", str(path), "--core-version", "0.1.0a2", "--load-kind", "EvalImporter"]), 2)
                importer.assert_not_called()
            with redirect_stderr(StringIO()):
                self.assertEqual(main(["validate", str(path), "--core-version", "99.0.0"]), 2)
