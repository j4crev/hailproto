#!/usr/bin/env python3
"""Build the pinned native CLI and install it at dist/racr."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

crate = Path(__file__).resolve().parents[1]
subprocess.run(["cargo", "build", "--release", "--locked"], cwd=crate, check=True)
target = Path(os.environ.get("CARGO_TARGET_DIR", crate / "target"))
if not target.is_absolute():
    target = crate / target
output = crate / "dist/racr"
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
    stage = Path(temporary.name)
try:
    shutil.copyfile(target / "release/racr", stage)
    stage.chmod(0o755)
    stage.replace(output)
finally:
    stage.unlink(missing_ok=True)
print(output)
