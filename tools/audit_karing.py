"""Read-only structural audit; this does not compile or validate runtime behavior."""
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1] / "karing"
missing = {}
files = list((root / "lib").rglob("*.dart"))
for file in files:
    source = re.sub(r"/\*.*?\*/", "", file.read_text(), flags=re.S)
    for target in re.findall(
        r"^\s*(?:import|export)\s+['\"]package:karing/([^'\"]+)", source, re.M
    ):
        if not (root / "lib" / target).exists():
            missing.setdefault(target, []).append(str(file.relative_to(root)))

result = {
    "repository": "https://github.com/KaringX/karing",
    "commit": subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip(),
    "scope": "Static local-package import scan; block comments removed; no build executed",
    "dart_files": len(files),
    "missing_internal_import_count": len(missing),
    "missing_internal_imports": dict(sorted(missing.items())),
    "external_paths_exist": {
        path: (root / path).exists()
        for path in [
            "../vpn-service",
            "bind/apple/Libbox.xcframework",
            "bind/apple/LibVpnCore/LibVpnCore.swift",
            "bind/windows/core",
            "bind/linux/core/karingService",
            "../private_for_build/karing/karing/android/sign/sentry.properties",
        ]
    },
}
print(json.dumps(result, ensure_ascii=False, indent=2))
