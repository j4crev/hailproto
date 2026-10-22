#!/usr/bin/env python3
"""Install only the three monitor-client settings, never signup enablement.

Called through the root-owned provider operations wrapper after console approval
of that wrapper update. The secret is read on stdin, not from command arguments.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

ENV = Path('/opt/hailproto/apps/server/deploy/public/.env')
FIELDS = ('SIGNUP_MONITOR_API_ORIGIN', 'SIGNUP_MONITOR_TOKEN', 'SIGNUP_MONITOR_PUBLIC_KEY')


def validate(value):
    if not isinstance(value, dict) or set(value) != set(FIELDS) or any(not isinstance(value[key], str) for key in FIELDS):
        raise ValueError('Supply only the three signup-monitor settings')
    url = urlsplit(value[FIELDS[0]])
    if url.scheme != 'https' or url.username or url.password or url.path or url.query or url.fragment or not url.hostname or url.netloc != url.hostname or not url.hostname.endswith('.plcmonitor.us') or value[FIELDS[0]] != 'https://' + url.hostname or any(
            not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in url.hostname.split('.')):
        raise ValueError('Use a canonical HTTPS API origin under plcmonitor.us without port or path')
    token = value[FIELDS[1]]
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token) or base64.urlsafe_b64encode(base64.urlsafe_b64decode(token + '=')).decode().rstrip('=') != token:
        raise ValueError('Use a canonical 32-byte service secret')
    if not re.fullmatch(r'did:key:z[1-9A-HJ-NP-Za-km-z]{1,128}', value[FIELDS[2]]):
        raise ValueError('Use the monitor public did:key value')
    return value


def replace_settings(old, value):
    lines, found = [], {}
    for line in old.splitlines(keepends=True):
        name = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else ''
        if name in FIELDS:
            if name in found: raise ValueError('Duplicate existing monitor setting requires review')
            existing = line.split('=', 1)[1].rstrip('\r\n')
            if existing and existing != value[name]: raise ValueError('Existing monitor configuration differs; review rotation explicitly')
            found[name] = True; lines.append(name + '=' + value[name] + ('\r\n' if line.endswith('\r\n') else '\n'))
        else: lines.append(line)
    result = ''.join(lines)
    missing = [name + '=' + value[name] + '\n' for name in FIELDS if name not in found]
    if missing and result and not result.endswith(('\n', '\r')): result += '\n'
    return result + ''.join(missing)


def main():
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192: raise ValueError('Configuration exceeds limit')
    value = validate(json.loads(raw))
    if sys.argv[1:] == ['--check-config']:
        print(json.dumps({'syntaxChecked': True, 'apiOrigin': value[FIELDS[0]]})); return
    if sys.argv[1:]: raise ValueError('Unexpected arguments')
    if os.geteuid() != 0: raise ValueError('Use the reviewed operations wrapper; root SSH is not required')
    if ENV.is_symlink() or ENV.stat().st_uid != 0 or ENV.stat().st_mode & 0o077:
        raise ValueError('Provider environment must be root-owned and private')
    old = ENV.read_text(); new = replace_settings(old, value)
    # Use the running reference provider's existing validator, including key
    # decoding, authority gates and dependencies. Never print its diagnostics.
    code = """import {loadConfig} from './src/config.ts';
const value=await new Response(Bun.stdin.stream()).json();
loadConfig({...process.env,...value});"""
    result = subprocess.run(['docker', 'exec', '-i', 'hail-public-provider-provider-1', 'bun', '--eval', code],
                            input=json.dumps(value).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode: raise ValueError('Provider rejected monitor configuration; no settings changed')
    if new == old:
        print(json.dumps({'configured': True, 'changed': False})); return
    subprocess.run(['/usr/local/sbin/hail-provider-backup'], check=True)
    backup = Path(tempfile.mkdtemp(prefix='hail-monitor-config-', dir='/var/lib')) / 'before.env'
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out: out.write(old)
    fd, path = tempfile.mkstemp(prefix='.env.monitor-', dir=ENV.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(new); out.flush(); os.fsync(out.fileno())
        os.replace(path, ENV)
    finally:
        if os.path.exists(path): os.unlink(path)
    print(json.dumps({'configured': True, 'changed': True, 'recreateRequired': True, 'backup': str(backup)}))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Monitor configuration refused; existing settings were preserved or require console rollback review', file=sys.stderr)
        raise SystemExit(1)
