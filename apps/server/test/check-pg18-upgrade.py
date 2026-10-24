#!/usr/bin/env python3
"""Focused controller checks. Real SQL/key compatibility is rehearsed separately."""
import copy
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'apps/plc-monitor/deploy/public'))
spec = importlib.util.spec_from_file_location('provider_upgrade', ROOT / 'apps/server/deploy/public/upgrade-pg18-provider.py')
upgrade = importlib.util.module_from_spec(spec); spec.loader.exec_module(upgrade)

for case in ('success', 'restore-failure', 'key-failure', 'preservation-failure', 'consumer-failure',
             'post-start-failure', 'post-backup-failure', 'concurrent-change', 'expired-backup', 'unexpected-candidate'):
    with tempfile.TemporaryDirectory(prefix='hail-provider-pg18-test-') as directory:
        root = Path(directory); deploy = root / 'deploy'; deploy.mkdir(); config = root / 'config'; stage = root / 'stage'; stage.mkdir()
        wrapper = root / 'ops'; backup = root / 'backup'; overlay = config / 'compose.yaml'
        required = {wrapper, backup, deploy / '.env', deploy / 'compose.yaml'}
        for path in required: path.write_bytes(b'original-' + path.name.encode())
        for name in ('provider-ops.sh', 'backup.sh'): (stage / name).write_bytes(b'new-' + name.encode())
        archive = stage / 'backup.gpg'; archive.write_bytes(b'encrypted fixture')
        before = {'public.schema_migrations': {'rows': 59, 'sha256': 'schema'}, 'public.account_keys': {'rows': 14, 'sha256': 'keys'}}
        plan = {'protected_files': {str(path): upgrade.digest(path) for path in required}, 'backup': {'sha256': upgrade.digest(archive),
                'created_epoch': 0 if case == 'expired-backup' else upgrade.time.time()}, 'application_image': 'same-app',
                'schema': before['public.schema_migrations'], 'tables': list(before)}
        (stage / 'plan.json').write_text(json.dumps(plan))
        state = {'version': 140024, 'volume': upgrade.OLD_VOLUME, 'events': [], 'commands': [], 'starts': 0, 'consumer_failed': False}
        base = {'services': {'db': {'image': 'old', 'volumes': [{'source': 'provider_db', 'target': '/var/lib/postgresql/data'}]},
                            'provider': {'image': 'same-app'}}, 'volumes': {'provider_db': {'name': upgrade.OLD_VOLUME}}}
        def compose(*args, overlay=None):
            if args[0] == 'config':
                value = copy.deepcopy(base)
                if overlay:
                    volume = overlay.read_text().split('    name: ')[1].strip()
                    value['services']['db'].update(image=upgrade.TARGET, volumes=[{'source': 'provider_pg18', 'target': '/var/lib/postgresql'}])
                    value['volumes'] = {'provider_pg18': {'name': volume, 'external': True}}
                    if case == 'unexpected-candidate': value['services']['provider']['image'] = 'other-app'
                return json.dumps(value).encode()
            state['events'].append(args)
            if args[0] == 'up':
                state['version'] = 180006 if overlay else 140024
                state['volume'] = overlay.read_text().split('    name: ')[1].strip() if overlay else upgrade.OLD_VOLUME
            if args == ('start', 'provider'): state['starts'] += 1
            return b''
        def inspect(name):
            return {'Image': 'same-app' if name == upgrade.APP else upgrade.OLD, 'Config': {'Env': []},
                    'State': {'Health': {'Status': 'healthy'}}, 'Mounts': [{'Type': 'volume', 'Name': state['volume'],
                    'Destination': '/var/lib/postgresql' if state['version'] == 180006 else '/var/lib/postgresql/data'}]}
        def query(statement):
            if statement == 'SHOW server_version_num': return str(state['version'])
            if 'json_object_agg' in statement: return json.dumps({'hail': True, 'postgres': True, 'template0': False, 'template1': True})
            if 'pg_database_size' in statement: return '1024'
            if 'rolpassword LIKE' in statement: return 't'
            if statement in (upgrade.DATABASE_METADATA, upgrade.ROLE_METADATA): return 'unchanged private metadata'
            return '0'
        def rows():
            value = copy.deepcopy(before)
            if state['version'] == 180006:
                if case == 'preservation-failure': value['public.account_keys']['sha256'] = 'changed'
                if case == 'concurrent-change': (deploy / '.env').write_bytes(b'operator-work')
            return value
        def run(args, **kwargs):
            state['commands'].append(args)
            if args[:2] == ['tailscale', 'ip']: return b'100.89.223.70\n'
            if args[:3] == ['docker', 'volume', 'ls']: return b''
            if 'pg_dumpall' in args: kwargs['stdout'].write(b'ALTER ROLE hail WITH SUPERUSER LOGIN PASSWORD \'fixture\';\n')
            if 'pg_dump' in args: kwargs['stdout'].write(b'dump')
            if 'pg_restore' in args and case == 'restore-failure': raise RuntimeError('fixture restore failure')
            if args[0] == 'curl' and case == 'post-start-failure': raise RuntimeError('fixture health failure')
            if args[0] == str(backup):
                if case == 'post-backup-failure': raise RuntimeError('fixture backup failure')
                return b'{"object":"fixture","sha256":"fixture"}'
            return b''
        def keys(*args):
            if case == 'key-failure': raise RuntimeError('fixture key failure')
            return {'account_keys_decrypted': 14, 'prepared_keys_decrypted': 6}
        actual_install = upgrade.install
        def install(path, *args, **kwargs):
            if path == backup and case == 'consumer-failure' and not state['consumer_failed']:
                state['consumer_failed'] = True; raise RuntimeError('fixture installation failure')
            return actual_install(path, *args, **kwargs)
        actual_stat = Path.stat
        def stat(path, *args, **kwargs):
            value = actual_stat(path, *args, **kwargs)
            if path in required | {archive, deploy, config}:
                fields = list(value); fields[4] = 0; return os.stat_result(fields)
            return value
        previous_umask = os.umask(0o022)
        try:
            with ExitStack() as patches:
                for name, value in {'__file__': str(stage / 'upgrade.py'), 'DEPLOY': deploy, 'CONFIG': config, 'OVERLAY': overlay,
                    'WRAPPER': wrapper, 'BACKUP': backup, 'WORK_PARENT': str(root), 'LOCK': str(root / 'lock'),
                    'BACKUP_LOCK': str(root / 'backup.lock'), 'compose': compose, 'inspect': inspect, 'query': query,
                    'rows': rows, 'run': run, 'check_keys': keys, 'install': install, 'wait_version': lambda *args: None}.items():
                    patches.enter_context(patch.object(upgrade, name, value))
                patches.enter_context(patch.object(upgrade.os, 'geteuid', return_value=0))
                patches.enter_context(patch.object(Path, 'stat', stat))
                patches.enter_context(patch.object(upgrade.shutil, 'chown'))
                patches.enter_context(patch.object(upgrade.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"readyConnections":4}')))
                try: upgrade.main()
                except (RuntimeError, SystemExit): assert case != 'success', case
                else: assert case == 'success', case
        finally: os.umask(previous_umask)
        reports = list(root.glob('hail-pg18-report-*/report.json'))
        if case in ('expired-backup', 'unexpected-candidate'):
            assert not reports and not state['events']; continue
        report = json.loads(reports[0].read_text())
        if case == 'success':
            assert report['status'] == 'passed' and state['version'] == 180006 and overlay.exists()
            assert report['application_probe']['prepared_keys_decrypted'] == 6
        elif case in ('post-start-failure', 'post-backup-failure'):
            assert state['version'] == 180006 and overlay.exists() and 'Not automatic' in report['rollback']
        elif case == 'concurrent-change':
            assert state['starts'] == 0 and (deploy / '.env').read_bytes() == b'operator-work' and 'operator review' in report['rollback']
        else:
            assert state['version'] == 140024 and state['volume'] == upgrade.OLD_VOLUME and state['starts'] == 1
            assert not overlay.exists() and wrapper.read_bytes() == b'original-ops' and backup.read_bytes() == b'original-backup'
        assert not any(args[:3] == ['docker', 'volume', 'rm'] for args in state['commands'])
print('PASS: provider scope, restore/key/data/install failures, concurrent edits, expired backups and write-safe rollback boundaries')

with tempfile.TemporaryDirectory(prefix='hail-provider-pg18-launcher-') as directory:
    root = Path(directory); capsule = root / 'capsule'; capsule.mkdir(); bin = root / 'bin'; bin.mkdir()
    deploy = root / 'deploy'; deploy.mkdir(); wrapper = root / 'ops'; backup = root / 'backup'
    for path in (deploy / '.env', deploy / 'compose.yaml', wrapper, backup): path.write_text('fixture-' + path.name)
    source = (ROOT / 'apps/server/deploy/public/run-pg18-provider-upgrade.sh').read_text()
    for old, new in {'/var/lib': str(root), '/usr/local/sbin/hail-provider-ops': str(wrapper), '/usr/local/sbin/hail-provider-backup': str(backup),
        '/opt/hailproto/apps/server/deploy/public': str(deploy),
        '963e376172b6d256ba8d09a92fc26afb5f7400d88633244e0d9668e06ee23fb7': upgrade.digest(wrapper),
        '2f2f1b0e01427fa8f550bbbdaac4cc00bdc9747184073aea5e12fecc760e4306': upgrade.digest(backup)}.items(): source = source.replace(old, new)
    (capsule / 'run.sh').write_text(source); (capsule / 'plan.json').write_text('{}')
    for name in ('upgrade-pg18-provider.py', 'pg14_checks.py', 'provider-ops.sh', 'backup.sh', 'check-pg18-clone.ts', 'check-monitor-api.sh', 'backup.gpg'):
        (capsule / name).write_text('fixture-code-or-ciphertext')
    (capsule / 'SHA256SUMS').write_text(''.join(upgrade.digest(path) + '  ' + path.name + '\n' for path in sorted(capsule.iterdir())))
    for name, body in {'id': 'echo 0', 'tailscale': 'echo 100.89.223.70', 'systemd-run': 'printf "%s\\n" "$@" > "$LOG"; exit 7',
                       'journalctl': 'echo "Backup expired; refresh off-host restore proof"'}.items():
        path = bin / name; path.write_text('#!/bin/sh\n' + body + '\n'); path.chmod(0o700)
    result = subprocess.run(['/bin/sh', str(capsule / 'run.sh')], env={**os.environ, 'PATH': str(bin) + ':' + os.environ['PATH'],
        'LOG': str(root / 'commands')}, capture_output=True, text=True)
    assert result.returncode == 7 and 'Backup expired' in result.stdout, result.stderr
    arguments = (root / 'commands').read_text(); protected_stage = next(root.glob('hail-pg18-provider-stage.*'))
    assert '--pipe' not in arguments and '--property=StandardOutput=journal' in arguments
    assert str(protected_stage / 'upgrade-pg18-provider.py') in arguments
    assert (protected_stage / 'backup.gpg').stat().st_mode & 0o777 == 0o600
print('PASS: provider launcher checksums, private ciphertext/code copy, journal-backed unit and visible preserved failure status')
