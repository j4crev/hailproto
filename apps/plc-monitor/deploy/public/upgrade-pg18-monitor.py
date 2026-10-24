#!/usr/bin/env python3
"""Console-only monitor logical migration. Retain both volumes; never downgrade after writes."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import time
import urllib.request

from pg14_checks import manifest, run, sql, wait_version

CONFIG = Path('/etc/hail-monitor-enrollment')
LEGACY = Path('/opt/hail/hail-plc-monitor-ts/deploy/public')
OVERLAY = CONFIG / 'compose.postgres.yaml'
WRAPPER = Path('/usr/local/sbin/hail-monitor-ops')
HELPER = CONFIG / 'operations.py'
DB = 'hail-public-monitor-db-1'
APP = 'hail-public-monitor-monitor-1'
OLD = 'sha256:50fce0c9c54c43d8b02ce16cb9daff75eb94c09c4ee3d41c157852ebd9700c80'
TARGET = 'postgres:18.6-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5'
OLD_VOLUME = 'hail-public-monitor_monitor_db'
WORK_PARENT = '/var/lib'
BACKUPS = Path('/var/lib/hail-monitor-enrollment')
LOCK = '/run/hail-monitor-pg18-update.lock'
DATABASE_METADATA = """SELECT row_to_json(d) FROM (SELECT pg_get_userbyid(datdba) AS owner,
 encoding,datcollate,datctype,datconnlimit,datacl::text AS acl FROM pg_database
 WHERE datname=current_database()) d"""
ROLE_METADATA = """SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,
 rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolpassword,rolvaliduntil,rolbypassrls
 FROM pg_authid WHERE rolname=current_user) r"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def compose(*args, overlay=None):
    command = ['docker', 'compose', '--env-file', str(LEGACY / '.env'),
               '--env-file', str(CONFIG / 'enrollment.env'), '-f', str(LEGACY / 'compose.yaml'),
               '-f', str(CONFIG / 'compose.override.json')]
    if overlay is not None: command += ['-f', str(overlay)]
    return run(command + list(args))


def protected(path):
    if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
        raise RuntimeError('Expected a protected root-owned configuration file')


def install(path, content, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.pg18-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content); output.flush(); os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def check_candidate(before, after, volume):
    old = copy.deepcopy(before); new = copy.deepcopy(after)
    db = new['services']['db']
    if db['image'] != TARGET or db.get('ports'):
        raise RuntimeError('Unexpected target image or published database port')
    if len(db['volumes']) != 1 or db['volumes'][0]['source'] != 'monitor_pg18' or db['volumes'][0]['target'] != '/var/lib/postgresql':
        raise RuntimeError('Candidate does not replace the legacy data mount')
    if new['volumes'].pop('monitor_pg18') != {'name': volume, 'external': True}:
        raise RuntimeError('Unexpected new-volume declaration')
    # Compose omits an unused legacy volume from its rendered model, not Docker.
    legacy_volume = old['volumes'].pop('monitor_db')
    if legacy_volume['name'] != OLD_VOLUME or new['volumes'].pop('monitor_db', legacy_volume) != legacy_volume:
        raise RuntimeError('Unexpected original-volume declaration')
    for config in (old, new):
        config['services']['db'].pop('image')
        config['services']['db'].pop('volumes')
    if old != new: raise RuntimeError('Candidate changes more than database image/storage')


def main():
    if os.geteuid() != 0 or run(['tailscale', 'ip', '-4']).decode().strip() != '100.102.184.47':
        raise SystemExit('Use only the approved monitor root console; POC is outside scope')
    os.umask(0o077)
    lock = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stage = Path(__file__).resolve().parent
    plan = json.loads((stage / 'plan.json').read_text())
    protected(CONFIG); protected(LEGACY)
    if OVERLAY.exists() or OVERLAY.is_symlink() or HELPER.exists():
        raise SystemExit('Migration artifacts already exist; inspect instead of rerunning')
    # Bind the operation to reviewed live configuration and the off-host restore proof.
    expected = {Path(path): checksum for path, checksum in plan['protected_files'].items()}
    required = {WRAPPER, CONFIG / 'active', CONFIG / 'compose.override.json', CONFIG / 'enrollment.env',
                LEGACY / '.env', LEGACY / 'compose.yaml'}
    if set(expected) != required: raise SystemExit('Incomplete configuration checkpoint')
    for path, checksum in expected.items():
        protected(path)
        if digest(path) != checksum: raise SystemExit('Live configuration changed; refresh the plan')
    archive = Path(plan['backup']['archive'])
    protected(archive)
    if archive.parent != BACKUPS or time.time() - archive.stat().st_mtime > 3600:
        raise SystemExit('Backup is over one hour old or outside the approved directory')
    if digest(archive) != plan['backup']['sha256']: raise SystemExit('Backup checksum mismatch')
    before_db = inspect(DB)
    if before_db['Image'] != OLD or int(sql(DB, 'SHOW server_version_num')) != 140024:
        raise SystemExit('Unexpected current database image/version')
    if [(m['Type'], m.get('Name'), m['Destination']) for m in before_db['Mounts']] != [('volume', OLD_VOLUME, '/var/lib/postgresql/data')]:
        raise SystemExit('Unexpected original data-volume mapping')
    if inspect(APP)['Image'] != plan['application_image']:
        raise SystemExit('Application image changed after the rehearsal')
    for name in (APP, DB):
        if inspect(name)['State'].get('Health', {}).get('Status') != 'healthy':
            raise SystemExit('Application/database must be healthy before maintenance')
    flags = json.loads(sql(DB, 'SELECT json_object_agg(datname,datallowconn) FROM pg_database'))
    if flags != {'monitor': True, 'postgres': True, 'template0': False, 'template1': True}:
        raise SystemExit('Unexpected database inventory')
    if sql(DB, "SELECT count(*) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'monitor'") != '0':
        raise SystemExit('Additional roles require a separate preservation plan')
    if sql(DB, "SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname=current_user") != 't':
        raise SystemExit('Non-SCRAM login credentials require a separate compatibility plan')
    if sql(DB, "SELECT count(*) FROM pg_class WHERE relkind IN ('S','p')") != '0' or sql(DB, 'SELECT count(*) FROM pg_replication_slots') != '0':
        raise SystemExit('Sequences/partitions/replication require a separate preservation plan')
    if sql(DB, "SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'") != '0':
        raise SystemExit('Unexpected extensions')
    if sql(DB, 'SELECT count(*) FROM pg_db_role_setting') != '0':
        raise SystemExit('Custom database/role settings require a separate preservation plan')
    if sql(DB, "SELECT count(*) FROM pg_database WHERE datacl IS NOT NULL AND datname='postgres'") != '0':
        raise SystemExit('Custom maintenance-database grants require a separate preservation plan')
    if sql(DB, "SELECT count(*) FROM pg_database WHERE datcollate <> 'en_US.utf8' OR datctype <> 'en_US.utf8' OR encoding <> 6") != '0':
        raise SystemExit('Unexpected locale/encoding')
    if int(sql(DB, 'SELECT pg_database_size(current_database())')) > 128 * 1024 * 1024:
        raise SystemExit('Database exceeds this bounded alpha maintenance plan')
    if shutil.disk_usage(WORK_PARENT).free < 1024 * 1024 * 1024:
        raise SystemExit('Require at least 1 GiB of free space before maintenance')
    run(['systemctl', 'is-active', '--quiet', 'hail-monitor-heartbeat.timer'])
    with urllib.request.urlopen('http://127.0.0.1:20241/ready', timeout=10) as response:
        if not json.load(response).get('readyConnections'): raise RuntimeError('Tunnel is not ready')
    print('Preflight passed; pulling PostgreSQL 18 before pausing any service.', flush=True)
    run(['docker', 'pull', TARGET])
    if '18.6' not in run(['docker', 'run', '--rm', '--pull=never', '--network', 'none', '--entrypoint', 'postgres', TARGET, '--version']).decode():
        raise RuntimeError('Unexpected target binary')
    work = Path(tempfile.mkdtemp(prefix='hail-pg18-monitor-', dir=WORK_PARENT))
    volume = 'hail-monitor-pg18-' + work.name.rsplit('-', 1)[-1]
    candidate = work / 'compose.postgres.yaml'
    candidate.write_text('services:\n  db:\n    image: ' + TARGET + '\n    volumes: !override\n'
        '      - type: volume\n        source: monitor_pg18\n        target: /var/lib/postgresql\n'
        'volumes:\n  monitor_pg18:\n    external: true\n    name: ' + volume + '\n')
    old_render = json.loads(compose('config', '--format', 'json'))
    new_render = json.loads(compose('config', '--format', 'json', overlay=candidate))
    check_candidate(old_render, new_render, volume)
    for service, container in (('db', DB), ('monitor', APP)):
        actual = dict(entry.split('=', 1) for entry in inspect(container)['Config']['Env'])
        if any(actual.get(key) != value for key, value in old_render['services'][service].get('environment', {}).items()):
            raise RuntimeError('Rendered configuration differs from the live container environment')
    if old_render['services']['db'].get('ports'): raise RuntimeError('Legacy database publishes a port')
    # Refuse unrelated preexisting volumes. There is deliberately no delete path.
    if volume in run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).decode().splitlines():
        raise RuntimeError('Candidate volume already exists')
    report_dir = Path(tempfile.mkdtemp(prefix='hail-pg18-report-', dir=WORK_PARENT))
    report = {'status': 'running', 'role': 'monitor', 'phase': 'prepared', 'work': str(work),
              'old_volume': OLD_VOLUME, 'new_volume': volume, 'target': TARGET}
    original_wrapper = WRAPPER.read_bytes()
    (work / 'before-wrapper.sh').write_bytes(original_wrapper)
    (work / 'before-compose.json').write_text(json.dumps(old_render, indent=2) + '\n')
    new_wrapper = (stage / 'monitor-ops.sh').read_bytes()
    helper_bytes = (stage / 'enrollment-setup.py').read_bytes()
    paused = False; switched = False; writing = False; consumers = False
    before = None
    try:
        if time.time() - archive.stat().st_mtime > 3600: raise RuntimeError('Backup expired during preparation')
        print('Beginning brief monitor/enrollment maintenance; the original PostgreSQL 14 volume will be retained.', flush=True)
        # The old cluster remains running/readable for manifest and dump, but has no writers.
        paused = True
        run(['systemctl', 'stop', 'hail-monitor-heartbeat.timer', 'hail-monitor-heartbeat.service'])
        compose('stop', 'monitor')
        if sql(DB, "SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()") != '0':
            raise RuntimeError('Unexpected connected clients after stopping the application')
        before = manifest(DB)
        database_metadata = sql(DB, DATABASE_METADATA)
        role_metadata = sql(DB, ROLE_METADATA)
        if before['public.schema_migrations'] != plan['schema'] or set(before) != set(plan['tables']):
            raise RuntimeError('Application schema differs from the restore-tested backup')
        (work / 'before-manifest.json').write_text(json.dumps(before, indent=2) + '\n')
        with (work / 'monitor.dump').open('wb') as dump:
            run(['docker', 'exec', DB, 'pg_dump', '-U', 'monitor', '-d', 'monitor', '-Fc', '--create'], stdout=dump)
        if manifest(DB) != before: raise RuntimeError('Database changed with the application stopped')
        # Preserve the login verifier and role attributes, not just table rows.
        with (work / 'roles.sql').open('wb') as output:
            run(['docker', 'exec', DB, 'pg_dumpall', '-U', 'monitor', '--roles-only'], stdout=output)
        for path, checksum in expected.items():
            if digest(path) != checksum: raise RuntimeError('Concurrent configuration edit; refusing overwrite')
        run(['docker', 'volume', 'create', '--label', 'org.hail.pg18-monitor=' + work.name, volume])
        report['phase'] = 'database-switch'
        switched = True
        compose('stop', 'db')
        compose('up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'db', overlay=candidate)
        wait_version(DB, 180006)
        mounts = inspect(DB)['Mounts']
        if [(m['Type'], m.get('Name'), m['Destination']) for m in mounts] != [('volume', volume, '/var/lib/postgresql')]:
            raise RuntimeError('Unexpected PostgreSQL 18 mount; keep application stopped')
        # Fresh initdb uses the same role name. Restore its exact PG14 login verifier
        # without printing it or failing on CREATE ROLE existing.
        role = sql(DB, 'SELECT current_user')
        if role != 'monitor': raise RuntimeError('Unexpected restored administrator')
        # pg_dumpall's CREATE ROLE would conflict with initdb. Apply only the reviewed
        # single role's ALTER ROLE statement, which includes its original verifier.
        role_sql = (work / 'roles.sql').read_text().splitlines()
        statements = [line for line in role_sql if line.startswith('ALTER ROLE monitor ')]
        if len(statements) != 1: raise RuntimeError('Unexpected role dump shape')
        run(['docker', 'exec', '-i', DB, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'monitor', '-d', 'monitor'],
            input=(statements[0] + '\n').encode())
        with (work / 'monitor.dump').open('rb') as dump:
            # --clean applies ONLY to the verified fresh PG18 volume, never PG14.
            # Recreating the empty target database preserves its original ACL/settings.
            if sql(DB, "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')") != '0':
                raise RuntimeError('Refusing to restore over a nonempty target database')
            run(['docker', 'exec', '-i', DB, 'pg_restore', '-U', 'monitor', '-d', 'postgres',
                 '--create', '--clean', '--if-exists', '--exit-on-error'], stdin=dump)
        if sql(DB, "SELECT datcollate || '/' || datctype FROM pg_database WHERE datname=current_database()") != 'en_US.utf8/en_US.utf8':
            raise RuntimeError('Restored database locale changed')
        sql(DB, 'ANALYZE')
        if manifest(DB) != before: raise RuntimeError('Exact retained-data comparison failed')
        if sql(DB, DATABASE_METADATA) != database_metadata or sql(DB, ROLE_METADATA) != role_metadata:
            raise RuntimeError('Database ownership/ACL/locale or role credentials changed')
        report.update({'phase': 'data-verified', 'version': 180006, 'data_preserved': True})
        # Persist routing before any production writer can restart. This overlay
        # belongs to database operations, not to a particular application release.
        for path, checksum in expected.items():
            if digest(path) != checksum: raise RuntimeError('Concurrent configuration edit; refusing overwrite')
        consumers = True
        install(HELPER, helper_bytes)
        install(WRAPPER, new_wrapper, 0o755)
        install(OVERLAY, candidate.read_bytes())
        # Set the point of no automatic rollback BEFORE starting a writer.
        writing = True
        report['phase'] = 'application-start'
        compose('start', 'monitor', overlay=OVERLAY)
        if inspect(APP)['Image'] != plan['application_image']: raise RuntimeError('Application image changed')
        run(['python3', str(HELPER), '--verify'])
        run(['systemctl', 'start', 'hail-monitor-heartbeat.service', 'hail-monitor-heartbeat.timer'])
        report['phase'] = 'post-upgrade-backup'
        report['post_upgrade_backup'] = json.loads(run(['python3', str(HELPER), '--backup']))
        report.update({'status': 'passed', 'phase': 'complete', 'application_image_unchanged': True,
                       'rollback': 'No automatic rollback after writes; retain both volumes and fix forward'})
        print('PASS: monitor PostgreSQL 18.6; exact data retained, original volume preserved, application unchanged.', flush=True)
    except Exception:
        report.update({'status': 'failed', 'failure_phase': report['phase']})
        if paused and not writing:
            try:
                if OVERLAY.exists():
                    if OVERLAY.read_bytes() != candidate.read_bytes(): raise RuntimeError('Concurrent overlay edit')
                    OVERLAY.unlink()
                if consumers:
                    if WRAPPER.read_bytes() not in (original_wrapper, new_wrapper) or (HELPER.exists() and HELPER.read_bytes() != helper_bytes):
                        raise RuntimeError('Concurrent operations-consumer edit')
                    install(WRAPPER, original_wrapper, 0o755); HELPER.unlink(missing_ok=True)
                for path, checksum in expected.items():
                    if digest(path) != checksum: raise RuntimeError('Concurrent configuration edit')
                if switched:
                    compose('up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'db')
                    wait_version(DB, 140024)
                if before is not None and manifest(DB) != before: raise RuntimeError('Original-volume preservation failed')
                compose('start', 'monitor')
                run(['systemctl', 'start', 'hail-monitor-heartbeat.service', 'hail-monitor-heartbeat.timer'])
                report['rollback'] = 'Original PostgreSQL 14 volume/config resumed before production writes'
            except Exception:
                report['rollback'] = 'Needs operator review; keep application stopped; both volumes and dump retained'
        else:
            report['rollback'] = 'Not automatic after application-start; never overwrite accepted writes with the old volume'
        raise RuntimeError('Migration failed; private diagnostics withheld; inspect the sanitized report') from None
    finally:
        path = report_dir / 'report.json'; path.write_text(json.dumps(report, indent=2) + '\n')
        shutil.chown(report_dir, user='root', group='hailops'); shutil.chown(path, user='root', group='hailops')
        report_dir.chmod(0o750); path.chmod(0o640)
        print('Sanitized report:', path, flush=True)


if __name__ == '__main__': main()
