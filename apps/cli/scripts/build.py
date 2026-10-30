#!/usr/bin/env python3
"""Build the pinned native CLI and install it at the historical artifact path."""
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
output = crate / "dist/hailp"
output.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temporary:
    stage = Path(temporary.name)
try:
    shutil.copyfile(target / "release/hailp", stage)
    stage.chmod(0o755)
    stage.replace(output)
finally:
    stage.unlink(missing_ok=True)
print(output)
