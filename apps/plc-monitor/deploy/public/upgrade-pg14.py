#!/usr/bin/env python3
"""One-time console-approved, minor-only monitor upgrade. Never restore/delete data."""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from pg14_checks import manifest, repair_catalog_views, run, sql, wait_version

DB = 'hail-public-monitor-db-1'
MONITOR = 'hail-public-monitor-monitor-1'
EDGE = 'hail-public-monitor-enrollment-edge-1'
OLD_IMAGE = 'sha256:044d29fc1be0f32f0e9a77f1f1ab3c9a2016b7654491a882a3c4824999ef1dd6'
TARGET = 'postgres:14.24-alpine@sha256:50fce0c9c54c43d8b02ce16cb9daff75eb94c09c4ee3d41c157852ebd9700c80'
CONFIG = Path('/etc/hail-monitor-enrollment')
OVERRIDE = CONFIG / 'compose.override.json'
LEGACY = Path('/opt/hail/hail-plc-monitor-ts/deploy/public')
BACKUPS = Path('/var/lib/hail-monitor-enrollment')
WORK_PARENT = '/var/lib'
LOCK = '/run/hail-monitor-pg14-update.lock'
TABLES = {'public.monitor_alerts','public.monitor_approvals','public.monitor_bootstrap_checkpoints',
          'public.monitor_cursor','public.monitor_observations','public.monitored_dids','public.schema_migrations'}


def compose(*args, override=OVERRIDE):
    return run(['docker','compose','--env-file',str(LEGACY/'.env'),
                '--env-file',str(CONFIG/'enrollment.env'),'-f',str(LEGACY/'compose.yaml'),
                '-f',str(override),*args])


def inspect(name):
    return json.loads(run(['docker','inspect',name]))[0]


def mounts(info):
    return sorted((m.get('Type'),m.get('Name'),m.get('Source'),m.get('Destination'),m.get('RW')) for m in info['Mounts'])


def atomic_config(content):
    fd,path=tempfile.mkstemp(prefix='.pg14-',dir=CONFIG)
    try:
        with os.fdopen(fd,'wb') as output:output.write(content);output.flush();os.fsync(output.fileno())
        os.replace(path,OVERRIDE)
    finally:
        Path(path).unlink(missing_ok=True)


def main():
    if os.geteuid()!=0 or run(['tailscale','ip','-4']).decode().strip()!='100.102.184.47':
        raise SystemExit('Use only the approved monitor root console')
    os.umask(0o077)
    lock=os.open(LOCK,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    stage=Path(__file__).resolve().parent
    plan=json.loads((stage/'plan.json').read_text())
    archive=Path(plan['backup']['archive'])
    if archive.parent!=BACKUPS or archive.is_symlink() or archive.stat().st_uid!=0:
        raise SystemExit('Unexpected protected backup location/owner')
    if time.time()-archive.stat().st_mtime>3600:
        raise SystemExit('Backup is over one hour old; prepare a fresh off-host recovery point first')
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=plan['backup']['sha256']:
        raise SystemExit('Backup checksum mismatch')
    if OVERRIDE.is_symlink() or OVERRIDE.stat().st_uid!=0 or OVERRIDE.stat().st_mode&0o022:
        raise SystemExit('Expected protected root-owned override')
    active=CONFIG/'active'
    if not active.is_file() or active.is_symlink() or active.stat().st_uid!=0:
        raise SystemExit('Expected the active, protected monorepo bridge')
    db_before=inspect(DB)
    if db_before['Image']!=OLD_IMAGE or int(sql(DB,'SHOW server_version_num'))!=140004:
        raise SystemExit('Unexpected current database image/version; review before changing anything')
    if sql(DB,"SELECT rolsuper FROM pg_roles WHERE rolname=current_user")!='t':
        raise SystemExit('Catalog repair requires the existing cluster administrator')
    flags=json.loads(sql(DB,'SELECT json_object_agg(datname,datallowconn) FROM pg_database','postgres'))
    if flags!={'monitor':True,'postgres':True,'template0':False,'template1':True}:
        raise SystemExit('Unexpected databases/connection policies; review catalog-repair scope')
    if sql(DB,'SELECT count(*) FROM pg_replication_slots')!='0':
        raise SystemExit('Replication slots require a separate compatibility review')
    if int(sql(DB,'SELECT pg_database_size(current_database())'))>128*1024*1024:
        raise SystemExit('Database exceeds this bounded alpha maintenance plan')
    monitor_state=inspect(MONITOR)['State']
    if (not monitor_state['Running'] or monitor_state.get('Health',{}).get('Status')!='healthy'
            or db_before['State'].get('Health',{}).get('Status')!='healthy' or not inspect(EDGE)['State']['Running']):
        raise SystemExit('Monitor/database/edge is not healthy; diagnose before maintenance')
    run(['systemctl','is-active','--quiet','hail-monitor-heartbeat.timer'])
    with urllib.request.urlopen('http://127.0.0.1:20241/ready',timeout=10) as response:
        if not json.load(response).get('readyConnections'):raise RuntimeError('Tunnel is not ready')
    print('Preflight passed; pulling the pinned minor image before pausing any service.',flush=True)
    run(['docker','pull',TARGET])
    version=run(['docker','run','--rm','--pull=never','--network','none','--entrypoint','postgres',TARGET,'--version']).decode()
    if '14.24' not in version:raise RuntimeError('Unexpected target binary')
    before_config=OVERRIDE.read_bytes()
    candidate=json.loads(before_config)
    candidate['services'].setdefault('db',{})['image']=TARGET
    work=Path(tempfile.mkdtemp(prefix='hail-pg14-update-',dir=WORK_PARENT))
    (work/'before.override.json').write_bytes(before_config)
    candidate_file=work/'candidate.json';candidate_file.write_text(json.dumps(candidate,indent=2)+'\n')
    old_render=json.loads(compose('config','--format','json'))
    new_render=json.loads(compose('config','--format','json',override=candidate_file))
    old_compare=copy.deepcopy(old_render);new_compare=copy.deepcopy(new_render)
    old_compare['services']['db'].pop('image');new_compare['services']['db'].pop('image')
    if old_compare!=new_compare:raise RuntimeError('Candidate changes more than the DB image')
    if old_render['services']['db'].get('ports'):raise RuntimeError('Database must not publish a host port')
    old_app_image=inspect(MONITOR)['Image']
    report_dir=Path(tempfile.mkdtemp(prefix='hail-db-update-report-',dir=WORK_PARENT))
    report={'status':'running','target':TARGET,'backup':str(archive),'work':str(work),'phase':'prepared'}
    paused=False;database_switch=False;app_started=False
    try:
        if time.time()-archive.stat().st_mtime>3600:
            raise RuntimeError('Backup expired during preparation; create a fresh recovery point')
        print('Beginning brief enrollment/monitor maintenance; no data restore or volume deletion.',flush=True)
        paused=True
        run(['systemctl','stop','hail-monitor-heartbeat.timer','hail-monitor-heartbeat.service'])
        # Keep the origin listener in place; enrollment temporarily returns 502
        # while its backend is stopped. Resume only after exact data comparison.
        compose('stop','monitor')
        before=manifest(DB)
        if set(before)!=TABLES or before['public.schema_migrations']['sha256']!=plan['schema_sha256']:
            raise RuntimeError('Live schema differs from the restore-tested snapshot')
        (work/'before-manifest.json').write_text(json.dumps(before,indent=2)+'\n')
        report['phase']='database-switch'
        if OVERRIDE.read_bytes()!=before_config:
            raise RuntimeError('Override changed concurrently; refusing to overwrite operator work')
        database_switch=True
        compose('stop','db')
        atomic_config(candidate_file.read_bytes())
        compose('up','-d','--no-deps','--force-recreate','--pull','never','db')
        wait_version(DB,140024)
        if mounts(inspect(DB))!=mounts(db_before):raise RuntimeError('Data-volume mapping changed')
        repair_catalog_views(DB)
        sql(DB,'REINDEX DATABASE monitor');sql(DB,'ANALYZE')
        if manifest(DB)!=before:raise RuntimeError('Application data preservation check failed')
        if sql(DB,"SELECT datallowconn FROM pg_database WHERE datname='template0'",'postgres')!='f':
            raise RuntimeError('Template0 connection policy was not restored')
        report.update({'phase':'data-verified','data_preserved':True,'version':140024,
                       'catalog_repair':'all databases/templates','reindex':True,'same_volume':True})
        app_started=True
        report['phase']='application-start'
        compose('start','monitor')
        if inspect(MONITOR)['Image']!=old_app_image:raise RuntimeError('Monitor application image changed')
        run(['python3','/opt/hailproto/apps/plc-monitor/deploy/public/enrollment-setup.py','--verify'])
        request=urllib.request.Request('http://127.0.0.1:8080/api/v1/onboarding',data=b'{}',
            headers={'Host':'enroll.plcmonitor.us','CF-Connecting-IP':'5.161.254.78','Content-Type':'application/json'})
        try:urllib.request.urlopen(request,timeout=15)
        except urllib.error.HTTPError as error:
            if error.code!=401:raise RuntimeError('Unexpected local enrollment status')
            error.close()
        else:raise RuntimeError('Enrollment unexpectedly accepted an unauthenticated request')
        run(['systemctl','start','hail-monitor-heartbeat.service','hail-monitor-heartbeat.timer'])
        report.update({'status':'passed','phase':'complete','application_image_unchanged':True})
        print('PASS: 14.24, unchanged data/volume/app image, catalog repair, reindex and monitor checks.',flush=True)
    except Exception as error:
        report.update({'status':'failed','error':str(error)})
        if paused and not app_started:
            # Only an image/config rollback, using the SAME volume. Never copy an
            # old dump over current data or delete a database volume automatically.
            try:
                if OVERRIDE.read_bytes() not in (before_config,candidate_file.read_bytes()):
                    raise RuntimeError('Concurrent override change; refusing rollback overwrite')
                if database_switch:
                    atomic_config(before_config)
                    compose('up','-d','--no-deps','--force-recreate','--pull','never','db')
                    wait_version(DB,140004)
                if 'before' in locals() and manifest(DB)!=before:
                    raise RuntimeError('Rollback data differs; keep backend stopped for review')
                compose('start','monitor')
                run(['systemctl','start','hail-monitor-heartbeat.service','hail-monitor-heartbeat.timer'])
                report['rollback']='previous image/config, same data volume'
            except Exception:
                report['rollback']='needs operator review; data and backups retained'
        elif app_started:
            report['rollback']='not automatic after app writes; inspect and fix forward, never restore stale data'
        print('STOP: maintenance failed; no data volume was deleted or restored. See sanitized report.',flush=True)
        raise
    finally:
        path=report_dir/'report.json';path.write_text(json.dumps(report,indent=2)+'\n')
        shutil.chown(report_dir,user='root',group='hailops');shutil.chown(path,user='root',group='hailops')
        report_dir.chmod(0o750);path.chmod(0o640)
        print('Sanitized report:',path,flush=True)


if __name__=='__main__':
    main()
