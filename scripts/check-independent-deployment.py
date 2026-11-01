#!/usr/bin/env python3
"""Exercise prebuilt images in a disposable, uniquely named local Compose project.

No public identities, production volumes, domains or credentials are used.
"""
import argparse
import json
import pathlib
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--provider-image', default='hail-provider:ci')
parser.add_argument('--client-image', default='hail-web-client:ci')
args = parser.parse_args()
profile = root / 'apps/server/deploy/standalone'
project = 'hail-separation-' + uuid.uuid4().hex[:12]

with tempfile.TemporaryDirectory(prefix=project) as temporary:
    directory = pathlib.Path(temporary)
    environment = directory / 'fixture.env'
    environment.write_text('\n'.join([
        f'HAIL_PROVIDER_IMAGE={args.provider_image}', f'HAIL_WEB_CLIENT_IMAGE={args.client_image}',
        'PROVIDER_DOMAIN=independent.example.com', 'PROVIDER_ID=independent',
        'PLC_PROVIDER_OPERATORS=["independent-operator"]',
        'DB_PASSWORD=disposable-test-only', 'KEY_ENCRYPTION_KEY=' + 'A' * 43,
        'HAIL_WEB_CLIENT_NAME=Independent Test', 'HAIL_WEB_CLIENT_LOGO_PATH=/brand/logo.svg',
        'HAIL_WEB_CLIENT_FAVICON_PATH=/brand/favicon.svg',
    ]) + '\n')
    brand = directory / 'brand'
    brand.mkdir()
    for name in ['logo.svg', 'favicon.svg']:
        (brand / name).write_text('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>')
    # Port 0 lets Docker allocate a free loopback port; no public listener is opened.
    provider_override = directory / 'provider.json'
    provider_override.write_text(json.dumps({'services': {'provider': {'ports': ['127.0.0.1::3000']}}}))
    client_override = directory / 'client.json'
    client_override.write_text(json.dumps({'services': {'web-client': {
        'volumes': [f'{brand}:/workspace/hailproto/apps/client/build/client/brand:ro']
    }}}))
    base = ['docker', 'compose', '--project-name', project, '--env-file', str(environment), '-f', str(profile / 'compose.yaml')]
    server = base + ['-f', str(provider_override)]
    client = base + ['-f', str(profile / 'compose.web-client.yaml'), '-f', str(provider_override), '-f', str(client_override)]

    def run(command, capture=False):
        return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE if capture else None).stdout

    def request(path):
        port = run(server + ['port', 'provider', '3000'], True).strip()
        try:
            with urllib.request.urlopen('http://' + port + path, timeout=10) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    try:
        rendered = json.loads(run(base + ['config', '--format', 'json'], True))
        assert 'web-client' not in rendered['services']
        assert 'WEB_CLIENT_ORIGIN' not in rendered['services']['provider']['environment']
        assert set(rendered['services']['provider']['depends_on']) == {'db'}
        run(server + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'db', 'provider'])
        assert request('/health/ready')[0] == 200
        assert request('/')[0] == 404
        assert request('/api/unknown')[0] == 404
        run(server + ['exec', '-T', 'provider', 'sh', '-c',
            'test ! -d /workspace/hailproto/apps/client && test -f src/cli/create-signup-invitation.ts'])
        print('PASS: provider-only migrations, readiness and API/page boundaries', flush=True)
        run(client + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'db', 'web-client', 'provider'])
        status, html = request('/')
        assert status == 200, (status, html[:300])
        assert 'Independent Test' in html and 'Haili' not in html
        assert '/brand/logo.svg' in html and '/brand/favicon.svg' in html
        assert request('/brand/logo.svg')[0] == 200
        assert request('/brand/favicon.svg')[0] == 200
        assert request('/api/unknown')[0] == 404
        assert request('/health/ready')[0] == 200
        print('PASS: optional independent client, runtime branding and mounted assets', flush=True)
    except BaseException:
        subprocess.run(client + ['logs', '--no-color', '--tail', '60'], check=False)
        raise
    finally:
        # Only this test's uniquely named project and disposable volumes are removed.
        subprocess.run(client + ['down', '--volumes', '--remove-orphans'], check=True)
