#!/usr/bin/env python3
"""Exercise the actual Caddy config with Docker and a local echo upstream.

Run from any directory: python3 apps/server/deploy/public/check-tunnel.py
No production connections, tokens, DNS changes or application writes.
"""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import threading
import time
import uuid


class Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(dict(self.headers)).encode())

    def log_message(self, *args):
        pass

    do_POST = do_GET


def request(port, headers, method='GET', path='/health/ready?check=1'):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        connection.request(method, path, headers=headers)
        response = connection.getresponse()
        return response.status, response.getheader('Location'), response.read()
    finally:
        connection.close()


def adapt(source):
    return json.loads(subprocess.check_output([
        'docker', 'run', '--rm', '-i',
        '-e', 'PROVIDER_DOMAIN=haili.example', 'caddy:2.10.2-alpine',
        'caddy', 'adapt', '--config', '/dev/stdin', '--adapter', 'caddyfile',
    ], input=source.encode()))


def main():
    image = 'caddy:2.10.2-alpine'
    config = adapt(Path(__file__).with_name('Caddyfile').read_text())
    servers = config['apps']['http']['servers']
    tunnel = next(server for server in servers.values() if ':8080' in server['listen'])
    assert len(servers) == 1 and tunnel['listen'] == [':8080'], 'Unexpected direct provider listener'
    deploy = Path(__file__).resolve().parent
    compose = json.loads(subprocess.check_output([
        'docker', 'compose', '--env-file', str(deploy / '.env.example'),
        '-f', str(deploy / 'compose.yaml'), 'config', '--format', 'json',
    ]))
    published = compose['services']['caddy']['ports']
    assert len(published) == 1 and published[0]['host_ip'] == '127.0.0.1'
    assert published[0]['target'] == 8080 and published[0]['published'] == '8080' and published[0]['protocol'] == 'tcp'
    assert all(not service.get('ports') for name, service in compose['services'].items() if name != 'caddy')
    script = Path(__file__).resolve().parents[3] / 'plc-monitor/deploy/public/enrollment-setup.py'
    spec = importlib.util.spec_from_file_location('monitor_setup', script)
    monitor_setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(monitor_setup)
    monitor_servers = adapt(monitor_setup.caddy('enroll.example'))['apps']['http']['servers']
    monitor = next(server for server in monitor_servers.values() if '127.0.0.1:8080' in server['listen'])
    assert len(monitor_servers) == 1 and monitor['listen'] == ['127.0.0.1:8080'], 'Unexpected direct monitor listener'
    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Echo)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    name = 'hail-tunnel-check-' + uuid.uuid4().hex
    ports = []
    for _ in range(2):
        reservation = socket.socket()
        reservation.bind(('127.0.0.1', 0))
        ports.append(reservation)
    tunnel_port, monitor_port = (reservation.getsockname()[1] for reservation in ports)
    for server, port in ((tunnel, tunnel_port), (monitor, monitor_port)):
        server['listen'] = [f'127.0.0.1:{port}']
        server.pop('tls_connection_policies', None)
        server['automatic_https'] = {'disable': True}
    config = {'admin': {'disabled': True}, 'apps': {'http': {'servers': {'tunnel': tunnel, 'monitor': monitor}}}}
    rendered = json.dumps(config).replace('provider:3000', f'127.0.0.1:{upstream.server_port}').replace('127.0.0.1:3001', f'127.0.0.1:{upstream.server_port}')
    process = None
    try:
        for reservation in ports:
            reservation.close()
        process = subprocess.Popen([
            'docker', 'run', '--rm', '--name', name, '-i', '--network', 'host',
            '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE', '--security-opt=no-new-privileges',
            '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/data', '--tmpfs', '/config', image,
            'caddy', 'run', '--config', '/dev/stdin',
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
        process.stdin.write(rendered.encode())
        process.stdin.close()
        for attempt in range(50):
            try:
                request(tunnel_port, {'Host': 'haili.example'})
                break
            except OSError:
                pass
            if process.poll() is not None:
                raise RuntimeError('Test Caddy exited before becoming ready')
            time.sleep(0.1)
        else:
            raise RuntimeError('Test Caddy did not become ready')
        headers = {'Host': 'haili.example', 'CF-Connecting-IP': '192.0.2.10',
                   'X-Hail-Trusted-Client-IP': '198.51.100.99', 'X-Forwarded-Proto': 'https'}
        for address in ('192.0.2.10', '2001:db8::10'):
            headers['CF-Connecting-IP'] = address
            status, _, body = request(tunnel_port, headers)
            assert status == 200, (status, body)
            forwarded = {key.lower(): value for key, value in json.loads(body).items()}
            assert forwarded['x-hail-trusted-client-ip'] == address
            assert forwarded['x-forwarded-proto'] == 'https'
        assert request(tunnel_port, {'Host': 'haili.example'})[0] == 400
        assert request(tunnel_port, {**headers, 'Host': 'other.example'})[0] == 400
        status, location, _ = request(tunnel_port, {**headers, 'X-Forwarded-Proto': 'http'})
        assert status == 308 and location == 'https://haili.example/health/ready?check=1'
        print('PASS: provider loopback-only publication, tunnel IPv4/IPv6, spoof overwrite, host/header guards, HTTPS redirect')
        path = '/api/v1/onboarding'
        for address in (monitor_setup.PROVIDER_IP, monitor_setup.PROVIDER_IPV6):
            headers = {'Host': 'enroll.example', 'CF-Connecting-IP': address}
            assert request(monitor_port, headers, 'POST', path)[0] == 200
        for headers in (
            {'Host': 'enroll.example'},
            {'Host': 'enroll.example', 'CF-Connecting-IP': '192.0.2.10'},
            {'Host': 'enroll.example', 'X-Forwarded-For': monitor_setup.PROVIDER_IP},
            {'Host': 'other.example', 'CF-Connecting-IP': monitor_setup.PROVIDER_IP},
        ):
            assert request(monitor_port, headers, 'POST', path)[0] == 403
        headers = {'Host': 'enroll.example', 'CF-Connecting-IP': monitor_setup.PROVIDER_IP}
        assert request(monitor_port, headers, 'GET', path)[0] == 403
        assert request(monitor_port, headers, 'POST', '/other')[0] == 403
        print('PASS: monitor tunnel preserves provider-only source, host, method and path restrictions')
    finally:
        subprocess.run(['docker', 'stop', '-t', '1', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if process is not None:
            process.wait(timeout=15)
        upstream.shutdown()
        upstream.server_close()


if __name__ == '__main__':
    main()
