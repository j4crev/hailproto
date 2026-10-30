#!/usr/bin/env python3
"""Check the package, crate, executable and optional release tag agree."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tomllib

crate = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--tag')
args = parser.parse_args()
package = json.loads((crate / 'package.json').read_text())['version']
rust = tomllib.loads((crate / 'Cargo.toml').read_text())['package']['version']
if package != rust or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', package):
    raise SystemExit('Cargo and package versions must agree and be release versions')
actual = subprocess.run([str(args.binary.resolve()), '--version'], capture_output=True, text=True, check=True)
if actual.stdout != package + '\n' or actual.stderr:
    raise SystemExit('Binary version/output does not match package version')
if args.tag is not None and args.tag != 'v' + package:
    raise SystemExit(f'Tag must equal v{package}')
print(f'Release versions agree: {package}')
