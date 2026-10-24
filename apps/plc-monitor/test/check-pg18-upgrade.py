#!/usr/bin/env python3
"""Stdlib control checks; real encrypted-copy/driver proofs are recorded separately."""
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parents[1] / 'deploy/public'
sys.path.insert(0, str(DEPLOY))
spec = importlib.util.spec_from_file_location('upgrade18', DEPLOY / 'upgrade-pg18-monitor.py')
upgrade = importlib.util.module_from_spec(spec); spec.loader.exec_module(upgrade)

for case in ('success', 'restore-failure', 'preservation-failure', 'post-start-failure',
             'post-backup-failure', 'overlay-install-failure', 'concurrent-change',
             'expired-backup', 'unexpected-candidate'):
    with tempfile.TemporaryDirectory(prefix='hail-pg18-control-') as directory:
        root = Path(directory)
        config = root / 'config'; legacy = root / 'legacy'; stage = root / 'stage'; backups = root / 'backups'
        for path in (config, legacy, stage, backups): path.mkdir()
        wrapper = root / 'wrapper'; wrapper.write_bytes(b'original-wrapper')
        overlay = config / 'compose.postgres.yaml'; helper = config / 'operations.py'
        required = {wrapper, config / 'active', config / 'compose.override.json', config / 'enrollment.env', legacy / '.env', legacy / 'compose.yaml'}
        for path in required - {wrapper}: path.write_text('protected fixture\n')
        archive = backups / 'backup.gpg'; archive.write_bytes(b'encrypted fixture')
        if case == 'expired-backup': os.utime(archive, (0, 0))
        (stage / 'monitor-ops.sh').write_bytes(b'new-wrapper')
        (stage / 'enrollment-setup.py').write_bytes(b'new-helper')
        before = {'public.schema_migrations': {'rows': 5, 'sha256': 'schema'}, 'public.monitored_dids': {'rows': 1, 'sha256': 'rows'}}
        plan = {'protected_files': {str(path): upgrade.digest(path) for path in required},
                'backup': {'archive': str(archive), 'sha256': upgrade.digest(archive)},
                'application_image': 'same-app', 'schema': before['public.schema_migrations'], 'tables': list(before)}
        (stage / 'plan.json').write_text(json.dumps(plan))
        state = {'version': 140024, 'events': [], 'commands': [], 'starts': 0, 'volume': upgrade.OLD_VOLUME}
        base = {'services': {'db': {'image': 'old', 'volumes': [{'source': 'monitor_db', 'target': '/var/lib/postgresql/data'}]},
                             'monitor': {'image': 'same-app'}}, 'volumes': {'monitor_db': {'name': upgrade.OLD_VOLUME}}}

        def composed(*args, overlay=None):
            if args[0] == 'config':
                value = copy.deepcopy(base)
                if overlay:
                    volume = overlay.read_text().split('    name: ')[1].strip()
                    value['services']['db'].update(image=upgrade.TARGET, volumes=[{'source': 'monitor_pg18', 'target': '/var/lib/postgresql'}])
                    value['volumes']['monitor_pg18'] = {'name': volume, 'external': True}
                    if case == 'unexpected-candidate': value['services']['monitor']['image'] = 'wrong-app'
                return json.dumps(value).encode()
            state['events'].append(args)
            if args[0] == 'up':
                state['version'] = 180006 if overlay else 140024
                state['volume'] = overlay.read_text().split('    name: ')[1].strip() if overlay else upgrade.OLD_VOLUME
            if args == ('start', 'monitor'): state['starts'] += 1
            return b''

        def inspected(name):
            return {'Image': ('same-app' if name == upgrade.APP else upgrade.OLD),
                    'Config': {'Env': []},
                    'State': {'Health': {'Status': 'healthy'}},
                    'Mounts': [{'Type': 'volume', 'Name': state['volume'], 'Destination': '/var/lib/postgresql' if state['version'] == 180006 else '/var/lib/postgresql/data'}]}

        def queried(container, query, *args):
            if query == 'SHOW server_version_num': return str(state['version'])
            if 'json_object_agg' in query: return json.dumps({'monitor': True, 'postgres': True, 'template0': False, 'template1': True})
            if 'pg_database_size' in query: return '1024'
            if 'datcollate ||' in query: return 'en_US.utf8/en_US.utf8'
            if query == 'SELECT current_user': return 'monitor'
            if 'rolpassword LIKE' in query: return 't'
            if query in (upgrade.DATABASE_METADATA, upgrade.ROLE_METADATA): return 'same-private-metadata'
            if query.startswith('SELECT count(*)'): return '0'
            return ''

        def rows(container):
            value = copy.deepcopy(before)
            if state['version'] == 180006:
                if case == 'preservation-failure': value['public.monitored_dids']['sha256'] = 'different'
                if case == 'concurrent-change': (config / 'enrollment.env').write_text('operator-work')
            return value

        def command(args, **kwargs):
            state['commands'].append(args)
            if args[:2] == ['tailscale', 'ip']: return b'100.102.184.47\n'
            if args[:2] == ['docker', 'run']: return b'postgres (PostgreSQL) 18.6\n'
            if args[:3] == ['docker', 'volume', 'ls']: return b''
            if 'pg_dumpall' in args: kwargs['stdout'].write(b'CREATE ROLE monitor;\nALTER ROLE monitor WITH SUPERUSER LOGIN PASSWORD \'fixture\';\n')
            if 'pg_dump' in args: kwargs['stdout'].write(b'dump-fixture')
            if 'pg_restore' in args and case == 'restore-failure': raise RuntimeError('fixture restore failure')
            if args[0] == 'python3' and case == 'post-start-failure': raise RuntimeError('fixture application check failure')
            if args[0] == 'python3' and args[-1] == '--backup':
                if case == 'post-backup-failure': raise RuntimeError('fixture backup failure')
                return b'{"archive":"fixture.gpg","sha256":"fixture"}'
            return b''

        real_install = upgrade.install
        def installed(path, *args, **kwargs):
            if path == overlay and case == 'overlay-install-failure': raise RuntimeError('fixture overlay installation failure')
            return real_install(path, *args, **kwargs)

        real_stat = Path.stat
        def stat(path, *args, **kwargs):
            value = real_stat(path, *args, **kwargs)
            if path in required | {archive, config, legacy}:
                fields = list(value); fields[4] = 0
                return os.stat_result(fields)
            return value

        previous_umask = os.umask(0o022)
        try:
            with ExitStack() as patches:
                for name, value in {'__file__': str(stage / 'upgrade.py'), 'CONFIG': config, 'LEGACY': legacy,
                    'OVERLAY': overlay, 'WRAPPER': wrapper, 'HELPER': helper, 'BACKUPS': backups,
                    'LOCK': str(root / 'lock'), 'WORK_PARENT': str(root), 'compose': composed,
                    'inspect': inspected, 'sql': queried, 'manifest': rows, 'run': command,
                    'install': installed,
                    'wait_version': lambda container, expected: None}.items():
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
            assert not reports and not state['events'] and state['version'] == 140024
            continue
        report = json.loads(reports[0].read_text())
        if case == 'success':
            assert report['status'] == 'passed' and state['version'] == 180006
            assert overlay.exists() and helper.read_bytes() == b'new-helper' and wrapper.read_bytes() == b'new-wrapper'
        elif case in ('post-start-failure', 'post-backup-failure'):
            assert state['version'] == 180006 and overlay.exists() and 'Not automatic' in report['rollback']
        elif case == 'concurrent-change':
            assert (config / 'enrollment.env').read_text() == 'operator-work'
            assert state['starts'] == 0 and 'operator review' in report['rollback']
        else:
            assert state['version'] == 140024 and state['volume'] == upgrade.OLD_VOLUME
            assert not overlay.exists() and not helper.exists() and wrapper.read_bytes() == b'original-wrapper'
            assert state['starts'] == 1
        assert not any('rm' in event for event in state['events']), 'No volume deletion path is allowed'
        assert not any(args[:3] == ['docker', 'volume', 'rm'] for args in state['commands'])

print('PASS: PG18 candidate scope, success, restore/data failures, pre-write rollback, post-write safety, concurrent edits and expired backups')

# Exercise the actual launcher, substituting only external host paths/commands.
with tempfile.TemporaryDirectory(prefix='hail-pg18-launcher-') as directory:
    root = Path(directory); capsule = root / 'capsule'; capsule.mkdir(); bin = root / 'bin'; bin.mkdir()
    config = root / 'config'; config.mkdir(); legacy = root / 'legacy'; legacy.mkdir()
    wrapper = root / 'wrapper'; wrapper.write_bytes(b'original-wrapper')
    for path in (config / 'active', config / 'compose.override.json', config / 'enrollment.env', legacy / '.env', legacy / 'compose.yaml'):
        path.write_text('fixture')
    source = (DEPLOY / 'run-pg18-monitor-upgrade.sh').read_text()
    for old, new in {'/var/lib': str(root), '/usr/local/sbin/hail-monitor-ops': str(wrapper),
        '/etc/hail-monitor-enrollment': str(config), '/opt/hail/hail-plc-monitor-ts/deploy/public': str(legacy),
        'bf27f41a62f32e093fb9f1693913e9d49be0842718b95038af00cc25ba62dc00': upgrade.digest(wrapper)}.items():
        source = source.replace(old, new)
    (capsule / 'run.sh').write_text(source)
    (capsule / 'plan.json').write_text('{}')
    for name in ('upgrade-pg18-monitor.py', 'pg14_checks.py', 'monitor-ops.sh', 'enrollment-setup.py'):
        (capsule / name).write_text('fixture-code')
    (capsule / 'SHA256SUMS').write_text(''.join(upgrade.digest(path) + '  ' + path.name + '\n' for path in sorted(capsule.iterdir())))
    commands = {'id': 'echo 0', 'tailscale': 'echo 100.102.184.47',
                'systemd-run': 'printf "%s\\n" "$@" > "$LOG"; exit 7',
                'journalctl': 'echo "Backup is over one hour old; refresh it"'}
    for name, body in commands.items():
        path = bin / name; path.write_text('#!/bin/sh\n' + body + '\n'); path.chmod(0o700)
    result = subprocess.run(['/bin/sh', str(capsule / 'run.sh')], env={**os.environ, 'PATH': str(bin) + ':' + os.environ['PATH'], 'LOG': str(root / 'commands')}, capture_output=True, text=True)
    assert result.returncode == 7 and 'Backup is over one hour old' in result.stdout, result.stderr
    arguments = (root / 'commands').read_text()
    assert '--pipe' not in arguments and '--property=StandardOutput=journal' in arguments
    protected_stage = next(root.glob('hail-pg18-stage.*'))
    assert str(protected_stage / 'upgrade-pg18-monitor.py') in arguments
    assert (protected_stage / 'upgrade-pg18-monitor.py').stat().st_mode & 0o777 == 0o600
print('PASS: launcher checksums/root-only copy, journal-backed detached service, visible failure and preserved exit status')
