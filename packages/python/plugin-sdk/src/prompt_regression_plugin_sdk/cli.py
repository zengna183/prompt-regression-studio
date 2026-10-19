"""Inspect a manifest without importing its code; loading is an explicit option."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Sequence

from .errors import PluginSdkError
from .loader import InProcessTrust, load_plugin
from .manifest import PluginKind, SDK_VERSION, ensure_core_compatible, load_manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prompt-regression-plugins")
    parser.add_argument("--version", action="version", version=SDK_VERSION)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="Validate data and compatibility without executing plugin code.")
    validate.add_argument("manifest", type=Path)
    validate.add_argument("--core-version", help="Defaults to the installed core version.")
    validate.add_argument("--load-kind", choices=[kind.value for kind in PluginKind])
    validate.add_argument("--trust-in-process", action="store_true", help="Acknowledge that selected plugin code executes without a sandbox.")
    args = parser.parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        ensure_core_compatible(manifest, core_version=args.core_version)
        loaded = False
        if args.load_kind:
            load_plugin(manifest, PluginKind(args.load_kind), core_version=args.core_version,
                        trust=InProcessTrust.ACKNOWLEDGED if args.trust_in_process else InProcessTrust.DENY)
            loaded = True
        print(json.dumps({"plugin_id": manifest.plugin_id, "version": manifest.version,
                          "kinds": [entry.kind.value for entry in manifest.entry_points],
                          "loaded": loaded}, sort_keys=True))
        return 0
    except (PluginSdkError, OSError) as error:
        print(f"plugin-check: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
