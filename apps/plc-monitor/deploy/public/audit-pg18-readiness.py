#!/usr/bin/env python3
"""Read-only major-upgrade inventory for the two approved production VPSs."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def run(args):
    result=subprocess.run(args,capture_output=True,text=True)
    if result.returncode:raise RuntimeError(args[0]+' inspection failed; output withheld')
    return result.stdout


def main():
    if os.geteuid()!=0:raise SystemExit('Use a production VPS root console')
    ip=run(['tailscale','ip','-4']).strip()
    roles={'100.102.184.47':('monitor','monitor','hail-public-monitor-db-1','hail-public-monitor-monitor-1'),
           '100.89.223.70':('provider','hail','hail-public-provider-db-1','hail-public-provider-provider-1')}
    if ip not in roles:raise SystemExit('Wrong VPS; POC is outside this migration')
    role,user,db,app=roles[ip]
    os.umask(0o077)
    info=json.loads(run(['docker','inspect',db]))[0]
    app_info=json.loads(run(['docker','inspect',app]))[0]
    query="""SELECT json_build_object(
 'version',current_setting('server_version_num'),
 'database',current_database(),'encoding',current_setting('server_encoding'),
 'size_bytes',pg_database_size(current_database()),
 'databases',(SELECT json_agg(json_build_object('name',datname,'allow_connections',datallowconn,'collate',datcollate,'ctype',datctype) ORDER BY datname) FROM pg_database),
 'extensions',(SELECT json_agg(json_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
 'roles',(SELECT json_agg(json_build_object('name',rolname,'superuser',rolsuper) ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_'),
 'sequences',(SELECT count(*) FROM pg_class WHERE relkind='S'),
 'partitioned_tables',(SELECT count(*) FROM pg_class WHERE relkind='p'),
 'replication_slots',(SELECT count(*) FROM pg_replication_slots))"""
    metadata=json.loads(run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on',db,
        'psql','-X','-Atq','-v','ON_ERROR_STOP=1','-U',user,'-d',user,'-c',query]))
    if role=='monitor':
        command=['docker','compose','--env-file','/opt/hail/hail-plc-monitor-ts/deploy/public/.env',
          '--env-file','/etc/hail-monitor-enrollment/enrollment.env','-f','/opt/hail/hail-plc-monitor-ts/deploy/public/compose.yaml',
          '-f','/etc/hail-monitor-enrollment/compose.override.json']
    else:
        command=['docker','compose','--env-file','/opt/hailproto/apps/server/deploy/public/.env',
          '-f','/opt/hailproto/apps/server/deploy/public/compose.yaml']
    overlay=Path('/etc/hail-monitor-enrollment/compose.postgres.yaml' if role=='monitor' else '/etc/hail-provider-postgres/compose.yaml')
    if overlay.exists(): command+=['-f',str(overlay)]
    # Rendered Compose contains credentials: keep it in memory and report only non-secret shape.
    rendered=json.loads(run(command+['config','--format','json']))
    service=rendered['services']['db']
    selected_env={}
    for entry in info['Config'].get('Env',[]):
        key,_,value=entry.partition('=')
        if key in ('PGDATA','PG_MAJOR','PG_VERSION'):selected_env[key]=value
    report={'role':role,'sql':metadata,'db_image':info['Config']['Image'],'db_image_id':info['Image'],
      'app_image':app_info['Config']['Image'],'app_image_id':app_info['Image'],
      'data_environment':selected_env,'db_mounts':info['Mounts'],
      'compose_db':{key:service.get(key) for key in ('image','volumes','networks','ports')},
      'compose_version':run(['docker','compose','version']).strip()}
    if role=='provider':
        # Account IDs/endpoints are metadata, not API secrets. Never print the other assignments.
        config=Path('/etc/hail-provider-backup')
        if config.exists():
            for line in config.read_text().splitlines():
                key,separator,value=line.strip().removeprefix('export ').partition('=')
                value=value.strip().strip("\"'")
                if separator and key.strip()=='R2_ACCOUNT_ID' and re.fullmatch('[0-9a-f]{32}',value):
                    report['backup_endpoint']='https://'+value+'.r2.cloudflarestorage.com'
                    report['backup_bucket']='haili-production-backups'
    directory=Path(tempfile.mkdtemp(prefix='hail-pg18-inventory-',dir='/var/lib'))
    file=directory/'report.json';file.write_text(json.dumps(report,indent=2)+'\n')
    shutil.chown(directory,user='root',group='hailops');shutil.chown(file,user='root',group='hailops')
    directory.chmod(0o750);file.chmod(0o640)
    print('Read-only PostgreSQL 18 inventory saved:',file)


if __name__=='__main__':main()
