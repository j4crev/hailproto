#!/usr/bin/env python3
"""Compare supplied standalone binaries without network or user credentials."""
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile
import time

binaries = [Path(value).resolve() for value in sys.argv[1:]]
assert binaries, 'Supply one or more executable paths'
env = {**os.environ, 'HAILP_CREDENTIAL_FILE': ''}
rows = []
with tempfile.TemporaryDirectory(prefix='hailp-bench-') as directory:
    vault, secret = Path(directory) / 'vault.json', Path(directory) / 'secret.txt'
    subprocess.run([str(binaries[0]), 'vault', 'create', '--vault', str(vault),
                    '--recovery-file', str(secret)], env=env, check=True, capture_output=True)
    for binary in binaries:
        row = {'binary': binary.name, 'bytes': binary.stat().st_size}
        for name, args, stdin in [
            ('version', ['--version'], ''),
            ('vault_verify', ['vault', 'verify', '--vault', str(vault), '--expected-did', 'unbound'], secret.read_text())
        ]:
            samples = []
            for iteration in range(33):
                start = time.perf_counter_ns()
                subprocess.run([str(binary), *args], env=env, input=stdin, text=True,
                               capture_output=True, check=True)
                elapsed = (time.perf_counter_ns() - start) / 1e6
                if iteration >= 3:
                    samples.append(elapsed)
            row[name] = {'median_ms': round(statistics.median(samples), 3),
                         'min_ms': round(min(samples), 3), 'samples': len(samples)}
        rows.append(row)
print(json.dumps({'platform': platform.platform(), 'architecture': platform.machine(),
                  'method': 'Warm local process wall time, 3 warmups then 30 samples; no network',
                  'results': rows}, indent=2))
