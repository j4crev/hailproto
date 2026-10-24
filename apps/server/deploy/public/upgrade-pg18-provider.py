#!/usr/bin/env python3
"""Console-only Haili migration into a new volume; never roll back accepted writes."""
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

DEPLOY = Path('/opt/hailproto/apps/server/deploy/public')
CONFIG = Path('/etc/hail-provider-postgres')
OVERLAY = CONFIG / 'compose.yaml'
WRAPPER = Path('/usr/local/sbin/hail-provider-ops')
BACKUP = Path('/usr/local/sbin/hail-provider-backup')
DB = 'hail-public-provider-db-1'
APP = 'hail-public-provider-provider-1'
OLD_VOLUME = 'hail-public-provider_provider_db'
OLD = 'sha256:50fce0c9c54c43d8b02ce16cb9daff75eb94c09c4ee3d41c157852ebd9700c80'
TARGET = 'postgres:18.6-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5'
WORK_PARENT = '/var/lib'
LOCK = '/run/hail-provider-pg18-update.lock'
BACKUP_LOCK = '/run/hail-provider-backup.lock'
DATABASE_METADATA = """SELECT row_to_json(d) FROM (SELECT pg_get_userbyid(datdba) AS owner,
 encoding,datcollate,datctype,datconnlimit,datacl::text AS acl FROM pg_database
 WHERE datname=current_database()) d"""
ROLE_METADATA = """SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,
 rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolpassword,rolvaliduntil,rolbypassrls
 FROM pg_authid WHERE rolname=current_user) r"""


def query(statement):
    return sql(DB, statement, 'hail', 'hail')


def rows():
    return manifest(DB, 'hail', 'hail')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]


def protected(path):
    if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
        raise RuntimeError('Expected protected root-owned configuration')


def install(path, content, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix='.pg18-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content); output.flush(); os.fsync(output.fileno())
        os.chmod(temporary, mode); os.replace(temporary, path)
    finally: Path(temporary).unlink(missing_ok=True)


def compose(*args, overlay=None):
    command = ['docker', 'compose', '--env-file', str(DEPLOY / '.env'), '-f', str(DEPLOY / 'compose.yaml')]
    if overlay is not None: command += ['-f', str(overlay)]
    return run(command + list(args))


def check_candidate(before, after, volume):
    old = copy.deepcopy(before); new = copy.deepcopy(after)
    db = new['services']['db']
    if db['image'] != TARGET or db.get('ports'):
        raise RuntimeError('Unexpected image or published database port')
    if len(db['volumes']) != 1 or db['volumes'][0]['source'] != 'provider_pg18' or db['volumes'][0]['target'] != '/var/lib/postgresql':
        raise RuntimeError('Legacy mount was not replaced')
    if new['volumes'].pop('provider_pg18') != {'name': volume, 'external': True}:
        raise RuntimeError('Unexpected new-volume declaration')
    legacy = old['volumes'].pop('provider_db')
    if legacy['name'] != OLD_VOLUME or new['volumes'].pop('provider_db', legacy) != legacy:
        raise RuntimeError('Original-volume declaration changed')
    for value in (old, new):
        value['services']['db'].pop('image'); value['services']['db'].pop('volumes')
    if old != new: raise RuntimeError('Candidate changes more than database image/storage')


def check_keys(stage, work, image):
    # Run only the SQL/key probe, never the application entrypoint or its workers.
    environment = dict(entry.split('=', 1) for entry in inspect(APP)['Config']['Env'])
    address = environment['DATABASE_URL']
    if '@db:5432/hail' not in address: raise RuntimeError('Unexpected application database endpoint')
    private = work / 'probe.env'
    probe = work / 'probe.ts'
    destination = '/workspace/hailproto/apps/server/deploy/public/check-pg18-clone.ts'
    try:
        private.write_text('LAB_DATABASE_URL=' + address.replace('@db:5432/hail', '@127.0.0.1:5432/hail') +
            '\nKEY_ENCRYPTION_KEY=' + environment['KEY_ENCRYPTION_KEY'] + '\nHAIL_BACKUP_REHEARSAL=isolated-pg18\n')
        probe.write_bytes((stage / 'check-pg18-clone.ts').read_bytes())
        probe.chmod(0o444)  # Public code only; the root-only parent protects host access.
        result = json.loads(run(['docker', 'run', '--rm', '--pull=never', '--network', 'container:' + DB,
            '--read-only', '--tmpfs', '/tmp', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory', '256m',
            '--env-file', str(private), '--mount', 'type=bind,src=' + str(probe) + ',dst=' + destination + ',readonly',
            '--workdir', '/workspace/hailproto/apps/server', '--entrypoint', 'bun', image, destination, 'provider']))
        if not result['driver_roundtrip'] or result['account_keys_decrypted'] != int(query('SELECT count(*) FROM account_keys')):
            raise RuntimeError('Retained account-key verification incomplete')
        expected = int(query("SELECT coalesce(sum(CASE WHEN custody_profile='managed' THEN 3 ELSE 2 END),0) FROM prepared_migration_target_keys"))
        if result['prepared_keys_decrypted'] != expected: raise RuntimeError('Prepared-transfer key verification incomplete')
        return result
    finally:
        private.unlink(missing_ok=True); probe.unlink(missing_ok=True)


def main():
    if os.geteuid() != 0 or run(['tailscale', 'ip', '-4']).decode().strip() != '100.89.223.70':
        raise SystemExit('Use only the approved Hetzner provider root console; POC is excluded')
    os.umask(0o077)
    locks = []
    for path in (LOCK, BACKUP_LOCK):
        fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); locks.append(fd)
    stage = Path(__file__).resolve().parent
    plan = json.loads((stage / 'plan.json').read_text())
    protected(DEPLOY)
    if CONFIG.exists(): protected(CONFIG)
    if OVERLAY.exists() or OVERLAY.is_symlink(): raise SystemExit('Database overlay already exists; do not rerun')
    expected = {Path(path): checksum for path, checksum in plan['protected_files'].items()}
    if set(expected) != {WRAPPER, BACKUP, DEPLOY / '.env', DEPLOY / 'compose.yaml'}:
        raise SystemExit('Incomplete protected configuration checkpoint')
    def unchanged():
        for path, checksum in expected.items():
            protected(path)
            if digest(path) != checksum: raise RuntimeError('Configuration changed; refusing overwrite')
    unchanged()
    archive = stage / 'backup.gpg'; protected(archive)
    if digest(archive) != plan['backup']['sha256'] or not 0 <= time.time() - plan['backup']['created_epoch'] <= 3600:
        raise SystemExit('Backup expired or checksum differs; refresh the off-host restore proof')
    source = inspect(DB)
    if source['Image'] != OLD or query('SHOW server_version_num') != '140024':
        raise SystemExit('Unexpected source database image/version')
    if [(m['Type'], m.get('Name'), m['Destination']) for m in source['Mounts']] != [('volume', OLD_VOLUME, '/var/lib/postgresql/data')]:
        raise SystemExit('Unexpected source data volume')
    if inspect(APP)['Image'] != plan['application_image']: raise SystemExit('Application image changed after rehearsal')
    for name in (APP, DB):
        if inspect(name)['State'].get('Health', {}).get('Status') != 'healthy': raise SystemExit('Unhealthy application/database')
    if json.loads(query('SELECT json_object_agg(datname,datallowconn) FROM pg_database')) != {'hail': True, 'postgres': True, 'template0': False, 'template1': True}:
        raise SystemExit('Unexpected databases')
    for statement in ("SELECT count(*) FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'hail'",
        "SELECT count(*) FROM pg_class WHERE relkind IN ('S','p')", 'SELECT count(*) FROM pg_replication_slots',
        "SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'", 'SELECT count(*) FROM pg_db_role_setting',
        "SELECT count(*) FROM pg_database WHERE datacl IS NOT NULL AND datname='postgres'",
        "SELECT count(*) FROM pg_database WHERE datcollate <> 'en_US.utf8' OR datctype <> 'en_US.utf8' OR encoding <> 6"):
        if query(statement) != '0': raise SystemExit('Unexpected cluster shape; review preservation scope')
    if query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname=current_user") != 't': raise SystemExit('Non-SCRAM credentials require review')
    if int(query('SELECT pg_database_size(current_database())')) > 256 * 1024 * 1024 or shutil.disk_usage(WORK_PARENT).free < 1024**3:
        raise SystemExit('Database/disk exceeds bounded alpha maintenance limits')
    run(['systemctl', 'is-active', '--quiet', 'hail-provider-backup.timer'])
    with urllib.request.urlopen('http://127.0.0.1:20241/ready', timeout=10) as response:
        if not json.load(response).get('readyConnections'): raise RuntimeError('Tunnel not ready')
    run(['sh', str(stage / 'check-monitor-api.sh')])
    print('Preflight passed; pulling PostgreSQL 18 before pausing Haili.', flush=True)
    run(['docker', 'pull', TARGET])
    work = Path(tempfile.mkdtemp(prefix='hail-pg18-provider-', dir=WORK_PARENT))
    volume = 'hail-provider-pg18-' + work.name.rsplit('-', 1)[-1]
    candidate = work / 'compose.yaml'
    candidate.write_text('services:\n  db:\n    image: ' + TARGET + '\n    volumes: !override\n'
        '      - type: volume\n        source: provider_pg18\n        target: /var/lib/postgresql\n'
        'volumes:\n  provider_pg18:\n    external: true\n    name: ' + volume + '\n')
    rendered = json.loads(compose('config', '--format', 'json'))
    check_candidate(rendered, json.loads(compose('config', '--format', 'json', overlay=candidate)), volume)
    for service, container in (('provider', APP), ('db', DB)):
        actual = dict(entry.split('=', 1) for entry in inspect(container)['Config']['Env'])
        if any(actual.get(key) != value for key, value in rendered['services'][service].get('environment', {}).items()): raise RuntimeError('Rendered environment differs from running application/database')
    if rendered['services']['db'].get('ports'): raise RuntimeError('Database publishes a port')
    if volume in run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).decode().splitlines(): raise RuntimeError('Target volume already exists')
    original = {WRAPPER: WRAPPER.read_bytes(), BACKUP: BACKUP.read_bytes()}
    replacement = {WRAPPER: (stage / 'provider-ops.sh').read_bytes(), BACKUP: (stage / 'backup.sh').read_bytes()}
    (work / 'before-compose.json').write_text(json.dumps(rendered, indent=2) + '\n')
    for path, content in original.items(): (work / ('before-' + path.name)).write_bytes(content)
    report_dir = Path(tempfile.mkdtemp(prefix='hail-pg18-report-', dir=WORK_PARENT))
    report = {'role': 'provider', 'status': 'running', 'phase': 'prepared', 'work': str(work), 'target': TARGET,
              'old_volume': OLD_VOLUME, 'new_volume': volume}
    paused = False; switched = False; consumers = False; writing = False; before = None
    try:
        if time.time() - plan['backup']['created_epoch'] > 3600: raise RuntimeError('Backup expired during preparation')
        print('Beginning brief Haili API maintenance; retain the original PostgreSQL 14 volume.', flush=True)
        paused = True
        run(['systemctl', 'stop', 'hail-provider-backup.timer'])
        compose('stop', 'provider')
        if query("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()") != '0': raise RuntimeError('Unexpected connected database clients')
        before = rows(); metadata = query(DATABASE_METADATA); role = query(ROLE_METADATA)
        if before['public.schema_migrations'] != plan['schema'] or set(before) != set(plan['tables']): raise RuntimeError('Schema differs from the restore-tested backup')
        (work / 'before-manifest.json').write_text(json.dumps(before, indent=2) + '\n')
        for name, command in (('hail.dump', ['pg_dump', '-U', 'hail', '-d', 'hail', '-Fc', '--create']), ('roles.sql', ['pg_dumpall', '-U', 'hail', '--roles-only'])):
            with (work / name).open('wb') as output: run(['docker', 'exec', DB, *command], stdout=output)
        if rows() != before: raise RuntimeError('Database changed while application stopped')
        unchanged()
        run(['docker', 'volume', 'create', '--label', 'org.hail.pg18-provider=' + work.name, volume])
        report['phase'] = 'database-switch'; switched = True
        compose('stop', 'db'); compose('up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'db', overlay=candidate)
        wait_version(DB, 180006, 'hail', 'hail')
        if [(m['Type'], m.get('Name'), m['Destination']) for m in inspect(DB)['Mounts']] != [('volume', volume, '/var/lib/postgresql')]: raise RuntimeError('Unexpected target mount')
        statements = [line for line in (work / 'roles.sql').read_text().splitlines() if line.startswith('ALTER ROLE hail ')]
        if len(statements) != 1: raise RuntimeError('Unexpected role dump shape')
        run(['docker', 'exec', '-i', DB, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'hail', '-d', 'hail'], input=(statements[0] + '\n').encode())
        if query("SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')") != '0': raise RuntimeError('Refusing restore over a nonempty target')
        with (work / 'hail.dump').open('rb') as dump:
            run(['docker', 'exec', '-i', DB, 'pg_restore', '-U', 'hail', '-d', 'postgres', '--create', '--clean', '--if-exists', '--exit-on-error'], stdin=dump)
        query('ANALYZE')
        if rows() != before or query(DATABASE_METADATA) != metadata or query(ROLE_METADATA) != role: raise RuntimeError('Retained data/database permissions/credentials changed')
        report['phase'] = 'retained-key-check'
        report['application_probe'] = check_keys(stage, work, plan['application_image'])
        if rows() != before: raise RuntimeError('Application probe changed retained data')
        unchanged()
        CONFIG.mkdir(mode=0o700, exist_ok=True)
        consumers = True
        for path, content in replacement.items(): install(path, content, 0o755)
        install(OVERLAY, candidate.read_bytes())
        writing = True; report['phase'] = 'application-start'
        compose('start', 'provider', overlay=OVERLAY)
        if inspect(APP)['Image'] != plan['application_image']: raise RuntimeError('Application image changed')
        for _ in range(75):
            if inspect(APP)['State'].get('Health', {}).get('Status') == 'healthy': break
            time.sleep(2)
        else: raise RuntimeError('Provider did not become healthy after restart')
        run(['curl', '--fail', '--retry', '24', '--retry-delay', '3', '--retry-all-errors', '--silent', '--show-error', '--max-time', '10', 'https://haili.app/health/ready'])
        run(['sh', str(stage / 'check-monitor-api.sh')])
        fcntl.flock(locks[1], fcntl.LOCK_UN)
        report['phase'] = 'post-upgrade-backup'
        report['post_upgrade_backup'] = json.loads(run([str(BACKUP)]))
        run(['systemctl', 'start', 'hail-provider-backup.timer'])
        report.update(status='passed', phase='complete', version=180006, data_preserved=True, application_image_unchanged=True,
                      rollback='No automatic rollback after writes; retain both volumes and fix forward')
        print('PASS: Haili PostgreSQL 18.6; data, credentials, retained keys and original volume preserved.', flush=True)
    except Exception:
        report.update(status='failed', failure_phase=report['phase'])
        if paused and not writing:
            try:
                if OVERLAY.exists():
                    if OVERLAY.read_bytes() != candidate.read_bytes(): raise RuntimeError('Concurrent overlay edit')
                    OVERLAY.unlink()
                if consumers:
                    for path in original:
                        if path.read_bytes() not in (original[path], replacement[path]): raise RuntimeError('Concurrent operations edit')
                    for path, content in original.items(): install(path, content, 0o755)
                unchanged()
                if switched:
                    compose('up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'db'); wait_version(DB, 140024, 'hail', 'hail')
                if before is not None and rows() != before: raise RuntimeError('Original-volume preservation failed')
                compose('start', 'provider'); run(['systemctl', 'start', 'hail-provider-backup.timer'])
                report['rollback'] = 'Original PostgreSQL 14 volume/config resumed before production writes'
            except Exception: report['rollback'] = 'Needs operator review; keep app stopped; retain both volumes and dump'
        else:
            report['rollback'] = 'Not automatic after application-start; never overwrite accepted writes'
            fcntl.flock(locks[1], fcntl.LOCK_UN)
            try: run(['systemctl', 'start', 'hail-provider-backup.timer'])
            except Exception: report['backup_timer'] = 'Needs operator review'
        raise RuntimeError('Migration failed; inspect the sanitized report; private diagnostics withheld') from None
    finally:
        path = report_dir / 'report.json'; path.write_text(json.dumps(report, indent=2) + '\n')
        shutil.chown(report_dir, user='root', group='hailops'); shutil.chown(path, user='root', group='hailops')
        report_dir.chmod(0o750); path.chmod(0o640)
        for fd in locks: os.close(fd)
        print('Sanitized report:', path, flush=True)


if __name__ == '__main__': main()
