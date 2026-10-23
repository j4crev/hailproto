#!/usr/bin/env python3
"""Control-flow proof only; SQL/data compatibility is tested separately in real clones."""
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
import urllib.error
import urllib.request

deploy=Path(__file__).resolve().parents[1]/'deploy/public'
sys.path.insert(0,str(deploy))
spec=importlib.util.spec_from_file_location('upgrade',deploy/'upgrade-pg14.py')
upgrade=importlib.util.module_from_spec(spec);spec.loader.exec_module(upgrade)

for case in ('success','preservation-failure','post-start-failure','concurrent-change'):
    with tempfile.TemporaryDirectory(prefix='hail-upgrade-control-') as directory:
        root=Path(directory);config=root/'config';config.mkdir();stage=root/'stage';stage.mkdir()
        backups=root/'backups';backups.mkdir();archive=backups/'backup.gpg';archive.write_bytes(b'ciphertext proof fixture')
        override=config/'compose.override.json';original={'services':{'monitor':{'ports':['127.0.0.1:3001:3001']}}}
        override.write_text(json.dumps(original));active=config/'active';active.write_text('reviewed bridge\n')
        (stage/'plan.json').write_text(json.dumps({'backup':{'archive':str(archive),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()},'schema_sha256':'schema-proof'}))
        before={name:{'rows':1,'sha256':'schema-proof' if name=='public.schema_migrations' else 'row-proof'} for name in upgrade.TABLES}
        state={'version':140004,'starts':0,'switches':0,'catalog':False,'events':[]}
        old_stat=Path.stat
        def checked_stat(path,*args,**kwargs):
            value=old_stat(path,*args,**kwargs)
            if path in (archive,override,active):
                fields=list(value);fields[4]=0;return os.stat_result(fields)
            return value
        def image():return json.loads(override.read_text())['services'].get('db',{}).get('image','postgres:14.4-alpine')
        def composed(*args,override=override):
            if args[:1]==('config',):
                candidate=json.loads(override.read_text())
                return json.dumps({'services':{'db':{'image':candidate['services'].get('db',{}).get('image','postgres:14.4-alpine'),'volumes':['same-volume']},'monitor':{'image':'same-app'}}}).encode()
            state['events'].append(args)
            if args[:1]==('up',):state['switches']+=1;state['version']=140024 if image()==upgrade.TARGET else 140004
            if args==('start','monitor'):state['starts']+=1
            return b''
        def inspected(name):
            return {'Image':upgrade.OLD_IMAGE if name==upgrade.DB and state['version']==140004 else ('new-db' if name==upgrade.DB else 'same-app'),
                    'State':{'Running':True,'Health':{'Status':'healthy'}},'Mounts':[{'Type':'volume','Name':'same','Source':'same','Destination':'/var/lib/postgresql/data','RW':True}]}
        def queried(container,query,database='monitor'):
            if query=='SHOW server_version_num':return str(state['version'])
            if 'rolsuper' in query:return 't'
            if 'json_object_agg' in query:return json.dumps({'monitor':True,'postgres':True,'template0':False,'template1':True})
            if 'pg_replication_slots' in query:return '0'
            if 'pg_database_size' in query:return '1024'
            if 'datallowconn' in query:return 'f'
            return ''
        def rows(container):
            value=copy.deepcopy(before)
            if case=='concurrent-change' and state['version']==140004:
                override.write_text(json.dumps({'services':{'monitor':{'operator':'keep this work'}}}))
            if case=='preservation-failure' and state['version']==140024:value['public.monitored_dids']['sha256']='changed'
            return value
        def command(args,**kwargs):
            if args[:2]==['tailscale','ip']:return b'100.102.184.47\n'
            if args[:2]==['docker','run']:return b'postgres (PostgreSQL) 14.24\n'
            if args[:1]==['python3'] and case=='post-start-failure':raise RuntimeError('simulated post-start check failure')
            return b''
        def ready(url,**kwargs):
            if isinstance(url,urllib.request.Request):raise urllib.error.HTTPError(url.full_url,401,'expected',{},None)
            return io.BytesIO(b'{"readyConnections":4}')
        def version(container,expected):assert state['version']==expected
        previous_umask=os.umask(0o022)
        try:
            with ExitStack() as patches:
                for attribute,value in {'__file__':str(stage/'upgrade.py'),'CONFIG':config,'OVERRIDE':override,
                    'BACKUPS':backups,'WORK_PARENT':str(root),'LOCK':str(root/'lock'),'compose':composed,
                    'inspect':inspected,'sql':queried,'manifest':rows,'run':command,'wait_version':version,
                    'repair_catalog_views':lambda container:state.update(catalog=True)}.items():
                    patches.enter_context(patch.object(upgrade,attribute,value))
                patches.enter_context(patch.object(upgrade.os,'geteuid',return_value=0))
                patches.enter_context(patch.object(Path,'stat',checked_stat))
                patches.enter_context(patch.object(upgrade.urllib.request,'urlopen',ready))
                patches.enter_context(patch.object(upgrade.shutil,'chown'))
                try:upgrade.main()
                except RuntimeError:assert case!='success'
                else:assert case=='success'
        finally:os.umask(previous_umask)
        report=json.loads(next(root.glob('hail-db-update-report-*/report.json')).read_text())
        if case=='success':
            assert report['status']=='passed' and report['same_volume'] and state['catalog'] and state['version']==140024
        elif case=='preservation-failure':
            assert report['status']=='failed' and state['version']==140004 and state['switches']==2
            assert json.loads(override.read_text())==original
        elif case=='post-start-failure':
            assert report['status']=='failed' and state['version']==140024 and state['switches']==1
            assert 'not automatic' in report['rollback']
        else:
            assert report['status']=='failed' and state['version']==140004 and state['switches']==0
            assert json.loads(override.read_text())['services']['monitor']['operator']=='keep this work'
print('PASS: success, rollback boundaries, new-write safety and concurrent operator-work preservation')
