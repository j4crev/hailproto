#!/usr/bin/env python3
"""Build isolated source, package/extract it, and run with no runtime on PATH."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

crate = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="hailp-install-") as directory:
    root = Path(directory)
    source = root / "source"
    source.mkdir()
    for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
        shutil.copyfile(crate / name, source / name)
    shutil.copytree(crate / "src", source / "src")
    env = {**os.environ, "CARGO_TARGET_DIR": str(root / "target")}
    subprocess.run(["cargo", "build", "--release", "--locked"], cwd=source, env=env, check=True)
    binary = root / "target/release/hailp"
    archive = root / "hailp-linux-x64.tar.gz"
    with tarfile.open(archive, "w:gz") as bundle:
        bundle.add(binary, arcname="hailp")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = root / (archive.name + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n")
    subprocess.run(["sha256sum", "--check", checksum.name], cwd=root, check=True)
    installed = root / "installed"
    installed.mkdir()
    with tarfile.open(archive) as bundle:
        bundle.extractall(installed, filter="data")
    env.update(PATH="", HAILP_CREDENTIAL_FILE="")

    def run(*args, secret="", expected=0):
        result = subprocess.run([str(installed / "hailp"), *args], env=env,
                                input=secret, text=True, capture_output=True)
        assert result.returncode == expected, result.stderr
        return result

    version = run("--version").stdout.strip()
    assert f'version = "{version}"' in (source / "Cargo.toml").read_text()
    assert "hailp" in run("account", "transfer", "--help").stdout
    error = run("--unknown", expected=1)
    assert json.loads(error.stderr)["error"]["code"] == "USAGE_ERROR"
    vault, recovery = root / "vault.json", root / "secret.txt"
    run("vault", "create", "--vault", str(vault), "--recovery-file", str(recovery))
    assert vault.stat().st_mode & 0o777 == 0o600
    assert recovery.stat().st_mode & 0o777 == 0o600
    verified = run("vault", "verify", "--vault", str(vault), "--expected-did", "unbound",
                   secret=recovery.read_text())
    assert json.loads(verified.stdout)["verified"] is True
    print(f"Fresh Rust source build, checksum, archive installation and smoke with an empty PATH passed ({version})")
