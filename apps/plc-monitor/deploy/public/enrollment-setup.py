#!/usr/bin/env python3
"""One-time, console-approved bridge from the legacy monitor to monorepo builds.

Keeps the old checkout, Compose project, PostgreSQL image/volume and signing-key
mounts. This is not a general-purpose privileged deployment interface.
"""
import argparse
import base64
import collections
import hashlib
import grp
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tarfile
import tempfile
import time

ROOT = Path('/opt/hailproto')
LEGACY = Path('/opt/hail/hail-plc-monitor-ts')
DEPLOY = LEGACY / 'deploy/public'
CONFIG = Path('/etc/hail-monitor-enrollment')
BACKUPS = Path('/var/lib/hail-monitor-enrollment')
WRAPPER = Path('/usr/local/sbin/hail-monitor-ops')
MONITOR = 'hail-public-monitor-monitor-1'
PROVIDER_IP = '5.161.254.78'
PROVIDER_IPV6 = '2a01:4ff:f0:a15f::1'
EXPECTED_MONITOR_KEY = 'did:key:z6Mknh84ZKz6BNm2mh4LFGKc1JkW2WN9ZdfCVRbi58s1k4Zr'
RECIPIENT = '870DECF2F98318BCDE17D4B8333035D2650B0400'
IMAGE = 'hail-plc-monitor-ts:public'
BASE = ['docker', 'compose', '--env-file', str(DEPLOY / '.env'), '-f', str(DEPLOY / 'compose.yaml')]


class SetupError(RuntimeError):
    """Safe, fixed operator-facing diagnostics; never includes secret inputs."""


def run(*args, **kwargs):
    return subprocess.run(list(args), check=True, **kwargs)


def text(*args):
    return subprocess.check_output(list(args), text=True).strip()


def validate(value):
    if not isinstance(value, dict) or set(value) != {'api_domain', 'enrollment_token'}:
        raise SetupError('Configuration requires only api_domain and enrollment_token')
    domain, token = value['api_domain'], value['enrollment_token']
    if not isinstance(domain, str) or len(domain) > 253 or not domain.endswith('.plcmonitor.us') or any(
            not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in domain.split('.')):
        raise SetupError('Use a canonical subdomain of plcmonitor.us')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token) or base64.urlsafe_b64encode(
            base64.urlsafe_b64decode(token + '=')).decode().rstrip('=') != token:
        raise SetupError('Use a canonical random 32-byte enrollment secret')
    return value


def override():
    # The legacy base remains authoritative for storage, DB image and key mounts.
    return {'services': {
        'monitor': {'build': {'context': str(ROOT), 'dockerfile': 'apps/plc-monitor/Dockerfile'},
                    'ports': ['127.0.0.1:3001:3001'], 'environment': {
                        name: '${' + name + ':?configure enrollment}' for name in (
                            'MONITOR_ENROLLMENT_TOKEN', 'MONITOR_ENROLLMENT_PROVIDER',
                            'MONITOR_ENROLLMENT_ALERT_ORIGIN', 'MONITOR_API_HOST', 'MONITOR_API_PORT')}},
        'enrollment-edge': {'image': 'caddy:2.10.2-alpine', 'restart': 'unless-stopped',
                            'network_mode': 'host', 'read_only': True, 'cap_drop': ['ALL'],
                            # The official binary needs this file capability even on 8080.
                            'cap_add': ['NET_BIND_SERVICE'], 'security_opt': ['no-new-privileges:true'],
                            'tmpfs': ['/tmp:size=16m,mode=1777'], 'volumes': [
                                str(CONFIG / 'Caddyfile') + ':/etc/caddy/Caddyfile:ro',
                                'enrollment_caddy_data:/data', 'enrollment_caddy_config:/config']}},
        'volumes': {'enrollment_caddy_data': {}, 'enrollment_caddy_config': {}}}


def caddy(domain):
    return '''{
  admin off
}

# Only the host-local cloudflared service may supply trusted Cloudflare headers.
:8080 {
  bind 127.0.0.1
  @tunnel_provider {
    host %s
    header CF-Connecting-IP %s
    header CF-Connecting-IP %s
    method POST
    path /api/v1/onboarding
  }
  handle @tunnel_provider {
    reverse_proxy 127.0.0.1:3001
  }
  handle {
    respond 403
  }
}
''' % (domain, PROVIDER_IP, PROVIDER_IPV6)


def compose():
    return ['docker', 'compose', '--env-file', str(DEPLOY / '.env'),
            '--env-file', str(CONFIG / 'enrollment.env'), '-f', str(DEPLOY / 'compose.yaml'),
            '-f', str(CONFIG / 'compose.override.json')]


def private_write(path, value, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb' if isinstance(value, bytes) else 'w') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())


def sql(query):
    return text(*BASE, 'exec', '-T', 'db', 'psql', '-U', 'monitor', '-d', 'monitor', '-At', '-c', query)


def snapshot():
    # Ignore only background-poll/delivery progress. Preserve every old immutable
    # row, while allowing newly observed operations and successful notifications.
    fields = {'monitored_dids': 'did,expected_cid,expected_state,alert_webhook_url,enrolled_at,coverage_since',
              'monitor_alerts': 'id,did,category,correlation,detail,created_at',
              'monitor_bootstrap_checkpoints': '*', 'monitor_approvals': '*',
              'monitor_observations': '*', 'schema_migrations': '*', 'monitor_cursor': 'singleton,last_seq'}
    result = {table: json.loads(sql("SELECT COALESCE(json_agg(row_to_json(t)),'[]') FROM (SELECT " + columns +
                                   ' FROM ' + table + ') t')) for table, columns in fields.items()}
    result['accepted_alert_receipts'] = json.loads(sql("SELECT COALESCE(json_agg(row_to_json(t)),'[]') FROM "
                                                      "(SELECT id,sent_at FROM monitor_alerts WHERE sent_at IS NOT NULL) t"))
    return result


def preserved(before, after):
    for table, rows in before.items():
        encode = lambda row: json.dumps(row, sort_keys=True, separators=(',', ':'))
        if collections.Counter(map(encode, rows)) - collections.Counter(map(encode, after[table])):
            raise SetupError('Retained monitor evidence changed: ' + table)


def backup_recipient(public_key):
    data = public_key.read_bytes()
    if b'PRIVATE KEY' in data:
        raise SetupError('Never place a private backup-decryption key on the monitor')
    shown = subprocess.check_output(['gpg', '--batch', '--with-colons', '--import-options', 'show-only', '--import'], input=data).decode()
    fingerprints = [line.split(':')[9] for line in shown.splitlines() if line.startswith('fpr:')]
    if RECIPIENT not in fingerprints or not any(line.startswith('pub:') for line in shown.splitlines()) or any(
            line.startswith(('sec:', 'ssb:')) for line in shown.splitlines()):
        raise SetupError('Backup public recipient does not match the reviewed fingerprint')
    return data


def backup(public_key):
    public_data = backup_recipient(public_key)
    group = grp.getgrnam('hailops').gr_gid
    if BACKUPS.exists() and (BACKUPS.is_symlink() or BACKUPS.stat().st_uid != 0 or BACKUPS.stat().st_mode & 0o022):
        raise SetupError('Unsafe existing backup directory')
    BACKUPS.mkdir(mode=0o750, exist_ok=True)
    os.chown(BACKUPS, 0, group); BACKUPS.chmod(0o750)
    archive = BACKUPS / ('monitor-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(4).hex() + '.tar.gpg')
    with tempfile.TemporaryDirectory(prefix='hail-monitor-backup-', dir='/var/tmp') as temporary:
        work = Path(temporary)
        with (work / 'monitor.dump').open('wb') as dump:
            run(*BASE, 'exec', '-T', 'db', 'pg_dump', '-U', 'monitor', '-d', 'monitor', '-Fc', stdout=dump)
        with (work / 'monitor.dump').open('rb') as dump:
            run(*BASE, 'exec', '-T', 'db', 'pg_restore', '--list', stdin=dump, stdout=subprocess.DEVNULL)
        with tarfile.open(work / 'backup.tar', 'w') as tar:
            tar.add(work / 'monitor.dump', arcname='monitor.dump')
            for name in ('.env', 'secrets', 'reviewed', 'compose.yaml'):
                path = DEPLOY / name
                if path.exists(): tar.add(path, arcname='legacy/' + name)
            for name in ('/etc/hail-monitor-heartbeat', '/usr/local/sbin/hail-monitor-heartbeat',
                         '/etc/systemd/system/hail-monitor-heartbeat.service', '/etc/systemd/system/hail-monitor-heartbeat.timer'):
                path = Path(name)
                if path.exists(): tar.add(path, arcname='host' + name)
            if CONFIG.exists(): tar.add(CONFIG, arcname='enrollment-config')
        home = work / 'gnupg'; home.mkdir(mode=0o700)
        run('gpg', '--homedir', str(home), '--batch', '--import', input=public_data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run('gpg', '--homedir', str(home), '--batch', '--trust-model', 'always', '--recipient', RECIPIENT,
            '--encrypt', '--output', str(archive), str(work / 'backup.tar'))
    os.chown(archive, 0, group); archive.chmod(0o640)
    return {'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}


def verify():
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        if text('docker', 'inspect', MONITOR, '--format', '{{.State.Health.Status}}') == 'healthy' and sql(
                "SELECT caught_up AND NOT EXISTS (SELECT 1 FROM monitored_dids WHERE NOT poll_ready OR last_polled_at IS NULL "
                "OR last_polled_at<clock_timestamp()-interval '5 minutes') FROM monitor_cursor WHERE singleton=true") == 't':
            probe = """const u='http://127.0.0.1:3001/api/v1/onboarding';
const post=async(headers)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{}'});
if((await post({})).status!==401||(await post({Authorization:'Bearer '+process.env.MONITOR_ENROLLMENT_TOKEN})).status!==400)process.exit(1);
import {MonitorSigner} from './src/signing.ts';import {cidForCbor} from '@atproto/common';import {encodeBase64Url} from '@hailproto/codec/base64url';
const signer=await MonitorSigner.fromPrivateFile(process.env.MONITOR_PRIVATE_KEY_FILE);
const bytes=new TextEncoder().encode(JSON.stringify({type:'hail.plc-monitor-email-binding',version:1,signupId:crypto.randomUUID(),
 signupHash:encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),did:'did:plc:'+'a'.repeat(24),operationCid:(await cidForCbor({probe:true})).toString(),issuedAt:Math.floor(Date.now()/1000)}));
const peer=await fetch(process.env.MONITOR_ENROLLMENT_ALERT_ORIGIN+'/hail/signup/binding',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
 headers:{'Content-Type':'application/json','X-Hail-Monitor-Key':signer.publicDidKey,'X-Hail-Monitor-Signature':encodeBase64Url(signer.signEmailBindingRequest(bytes))},body:bytes});
if(peer.status!==409)process.exit(1);"""
            if subprocess.run(['docker', 'exec', MONITOR, 'bun', '--eval', probe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                return
        time.sleep(2)
    raise SetupError('Monitor health or private API verification failed')


def restore_legacy(image, wrapper):
    # Runtime-only rollback: never restore an older database over newer evidence.
    if CONFIG.exists(): subprocess.run([*compose(), 'stop', 'enrollment-edge'])
    run('docker', 'tag', image, IMAGE)
    run(*BASE, 'up', '-d', '--no-deps', '--force-recreate', 'monitor')
    WRAPPER.write_bytes(wrapper); WRAPPER.chmod(0o755)
    (CONFIG / 'active').unlink(missing_ok=True)


def apply(config, public_key, commit):
    if Path(__file__).resolve().parents[4] != ROOT or ROOT.stat().st_uid != 0 or ROOT.stat().st_mode & 0o022:
        raise SetupError('Run only from the protected /opt/hailproto monorepo checkout')
    if not re.fullmatch('[0-9a-f]{40}', commit) or text('git', '-C', str(ROOT), 'rev-parse', 'HEAD') != commit or text('git', '-C', str(ROOT), 'status', '--porcelain'):
        raise SetupError('Source must be the requested clean, pinned release')
    if CONFIG.exists(): raise SetupError('Enrollment configuration already exists; review it instead of overwriting')
    if text('git', '-C', str(LEGACY), 'status', '--porcelain'): raise SetupError('Legacy deployment has unrelated changes')
    public_data = backup_recipient(public_key); grp.getgrnam('hailops')
    # Public HTTPS/DNS belong to Cloudflare Tunnel, not a direct origin address.
    for port in (8080, 3001):
        with socket.socket() as listener: listener.bind(('0.0.0.0', port))
    versions = sql('SELECT version,checksum FROM schema_migrations ORDER BY version').splitlines()
    if len(versions) != len(list((ROOT / 'apps/plc-monitor/migrations').glob('0*.sql'))):
        raise SetupError('Unreviewed monitor schema transition')
    for line in versions:
        version, digest = line.split('|')
        files = list((ROOT / 'apps/plc-monitor/migrations').glob('%04d_*.sql' % int(version)))
        if len(files) != 1 or hashlib.sha256(files[0].read_bytes()).hexdigest() != digest:
            raise SetupError('Monitor schema checksum mismatch; separate migration review required')
    mounts = json.loads(text('docker', 'inspect', MONITOR, '--format', '{{json .Mounts}}'))
    if not any(item['Destination'] == '/run/monitor' and item['Source'] == str(DEPLOY / 'secrets') for item in mounts):
        raise SetupError('Unexpected signing-key mount; review backup and deployment paths')
    environment = json.loads(text('docker', 'inspect', MONITOR, '--format', '{{json .Config.Env}}'))
    if 'MONITOR_PRIVATE_KEY_FILE=/run/monitor/monitor.pkcs8' not in environment:
        raise SetupError('Unexpected signing-key path; review before migration')
    old_image = text('docker', 'inspect', MONITOR, '--format', '{{.Image}}')
    if text('docker', 'inspect', MONITOR, '--format', '{{.State.Health.Status}}') != 'healthy':
        raise SetupError('Monitor is not healthy; investigate before changing its runtime')
    if subprocess.run(['systemctl', 'is-active', '--quiet', 'hail-monitor-heartbeat.timer']).returncode:
        raise SetupError('Heartbeat supervision is not active; investigate before rollout')
    old_wrapper = WRAPPER.read_bytes()
    candidate = 'hail-plc-monitor-ts:enrollment-' + commit[:12]
    run('docker', 'build', '-f', str(ROOT / 'apps/plc-monitor/Dockerfile'), '-t', candidate, str(ROOT))
    run('docker', 'pull', 'caddy:2.10.2-alpine')
    key_probe = "import {MonitorSigner} from './src/signing.ts'; console.log((await MonitorSigner.fromPrivateFile('/run/monitor/monitor.pkcs8')).publicDidKey)"
    candidate_key = text('docker', 'run', '--rm', '--network', 'none', '--mount',
                         'type=bind,src=' + str(DEPLOY / 'secrets') + ',dst=/run/monitor,readonly', candidate, 'bun', '--eval', key_probe)
    if candidate_key != EXPECTED_MONITOR_KEY:
        raise SetupError('Signing key differs from the reviewed running monitor identity; do not restart it blindly')
    # Build first. Downtime starts only for the consistent snapshot and switch.
    try:
        run(*BASE, 'stop', 'monitor')
        before = snapshot()
        receipt = backup(public_key)
        CONFIG.mkdir(mode=0o700)
        private_write(CONFIG / 'compose.override.json', json.dumps(override(), indent=2))
        private_write(CONFIG / 'Caddyfile', caddy(config['api_domain']))
        private_write(CONFIG / 'enrollment.env', 'MONITOR_ENROLLMENT_TOKEN=' + config['enrollment_token'] + '\n' +
                      'MONITOR_ENROLLMENT_PROVIDER=https://haili.app\nMONITOR_ENROLLMENT_ALERT_ORIGIN=https://alerts.plcmonitor.us\nMONITOR_API_HOST=0.0.0.0\nMONITOR_API_PORT=3001\n')
        private_write(CONFIG / 'backup-public.asc', public_data)
        private_write(CONFIG / 'previous-wrapper', old_wrapper.decode())
        private_write(CONFIG / 'rollout.json', json.dumps({'commit': commit, 'previousImage': old_image, **receipt}))
        run(*compose(), 'config', '--quiet')
        run('docker', 'run', '--rm', '--network', 'none', '--mount', 'type=bind,src=' + str(CONFIG / 'Caddyfile') + ',dst=/etc/caddy/Caddyfile,readonly',
            'caddy:2.10.2-alpine', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile')
        run('docker', 'tag', candidate, IMAGE)
        run(*compose(), 'up', '-d', '--no-deps', 'monitor')
        verify(); preserved(before, snapshot())
        monitor_key = text('docker', 'exec', MONITOR, 'bun', '--eval', "import {MonitorSigner} from './src/signing.ts'; console.log((await MonitorSigner.fromPrivateFile(process.env.MONITOR_PRIVATE_KEY_FILE)).publicDidKey)")
        if monitor_key != candidate_key: raise SetupError('Signing key changed during rollout; review before continuing')
        state = {'commit': commit, 'previousImage': old_image, 'apiOrigin': 'https://' + config['api_domain'],
                 'monitorPublicKey': monitor_key, 'beforeBackup': receipt}
        (CONFIG / 'rollout.json').write_text(json.dumps(state))
        run(*compose(), 'up', '-d', '--no-deps', 'enrollment-edge')
        private_write(CONFIG / 'active', commit + '\n')
        run('install', '-o', 'root', '-g', 'root', '-m', '0755', str(ROOT / 'apps/plc-monitor/deploy/public/monitor-ops.sh'), str(WRAPPER))
        after_backup = backup(public_key)
        (CONFIG / 'rollout.json').write_text(json.dumps({**state, 'backup': after_backup}))
        print(json.dumps({'configured': True, 'apiOrigin': 'https://' + config['api_domain'], 'commit': commit,
                          'monitorPublicKey': monitor_key, 'beforeBackup': receipt, 'backup': after_backup,
                          'tlsExternalVerificationRequired': True}))
    except BaseException:
        restore_legacy(old_image, old_wrapper)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check-config', type=Path); mode.add_argument('--apply', type=Path)
    mode.add_argument('--verify', action='store_true'); mode.add_argument('--backup', action='store_true')
    mode.add_argument('--rollback-legacy', action='store_true')
    parser.add_argument('--backup-key', type=Path); parser.add_argument('--commit')
    args = parser.parse_args()
    if args.check_config or args.apply:
        path = args.check_config or args.apply
        if path.stat().st_mode & 0o077: raise SetupError('Configuration must be private (0600)')
        config = validate(json.loads(path.read_text()))
        if args.check_config:
            print(json.dumps({'valid': True, 'apiOrigin': 'https://' + config['api_domain']})); return
    if os.geteuid() != 0: raise SetupError('Console-approved root setup is required; do not enable root SSH')
    if args.apply:
        if not args.backup_key or not args.commit: raise SetupError('--backup-key and --commit are required')
        apply(config, args.backup_key.resolve(), args.commit)
    elif args.verify: verify(); print('Monitor API and polling healthy')
    elif args.rollback_legacy:
        state = json.loads((CONFIG / 'rollout.json').read_text())
        restore_legacy(state['previousImage'], (CONFIG / 'previous-wrapper').read_bytes())
        print('Legacy runtime restored; database and signing keys were not reverted')
    else: print(json.dumps(backup(CONFIG / 'backup-public.asc')))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # Never print input configuration, subprocess stdin or vendor response bodies.
        message = str(error) if isinstance(error, SetupError) else type(error).__name__ + ': setup refused or failed; inspect the reviewed preconditions'
        print(message, file=__import__('sys').stderr)
        raise SystemExit(1)
