#!/usr/bin/env python3
"""Console-only enablement of invited signup. Does not create an account or DID."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

ENV = Path('/opt/hailproto/apps/server/deploy/public/.env')
FIELDS = ('PUBLIC_ALPHA_SIGNUP', 'ALPHA_SIGNUP_INVITE_KEY', 'ALPHA_SIGNUP_MONITOR_ORIGIN')


def candidate(old):
    values = {FIELDS[0]: 'true', FIELDS[1]: secrets.token_urlsafe(32), FIELDS[2]: 'https://plcmonitor.us'}
    found = set()
    lines = []
    for line in old.splitlines(keepends=True):
        name = line.split('=', 1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else ''
        if name in FIELDS:
            allowed = ('', 'false') if name == 'PUBLIC_ALPHA_SIGNUP' else ('',)
            if name in found or line.split('=', 1)[1].strip() not in allowed:
                raise ValueError('Existing pilot configuration requires review; do not rotate its key')
            found.add(name)
            lines.append(name + '=' + values[name] + '\n')
        else:
            lines.append(line)
    text = ''.join(lines)
    if text and not text.endswith('\n'): text += '\n'
    return text + ''.join(name + '=' + values[name] + '\n' for name in FIELDS if name not in found), values


def main():
    if os.geteuid() != 0 or ENV.is_symlink() or ENV.stat().st_uid != 0 or ENV.stat().st_mode & 0o077:
        raise ValueError('Use the provider console with its root-owned private environment')
    old = ENV.read_text()
    new, values = candidate(old)
    # Validate the full production configuration and mint exactly one invitation.
    # Signing/service keys never go into arguments, output, or the GUI environment.
    code = """import {loadConfig} from './src/config.ts';
import {createSignupInvitation} from './src/onboarding/invitation.ts';
const values=await new Response(Bun.stdin.stream()).json();const config=loadConfig({...process.env,...values});
if(config.publicOrigin!=='https://haili.app')throw new Error('Wrong provider');
console.log(config.publicOrigin+'/signup#invitation='+createSignupInvitation(config.publicOrigin,values.ALPHA_SIGNUP_INVITE_KEY));"""
    result = subprocess.run(['docker', 'exec', '-i', 'hail-public-provider-provider-1', 'bun', '--eval', code],
                            input=json.dumps(values).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    url = result.stdout.decode().strip()
    if not url.startswith('https://haili.app/signup#invitation=') or len(url) > 2048: raise ValueError('Unexpected invitation')
    subprocess.run(['/usr/local/sbin/hail-provider-backup'], check=True)
    backup = Path(tempfile.mkdtemp(prefix='hail-signup-pilot-', dir='/var/lib')) / 'before.env'
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out: out.write(old)
    fd, name = tempfile.mkstemp(prefix='.env.pilot-', dir=ENV.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(new); out.flush(); os.fsync(out.fileno())
        os.replace(name, ENV)
    finally:
        if os.path.exists(name): os.unlink(name)
    # The operator is the intended recipient. This URL is not a service secret.
    print('Invited signup configured. Recreate through hail-provider-ops deploy before opening:')
    print(url)
    print('Root-only pre-change environment: ' + str(backup))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Pilot enablement refused or failed; inspect configuration and retained backup in the console. No account was created.', file=__import__('sys').stderr)
        raise SystemExit(1)
