#!/usr/bin/env python3
"""Exercise the exact release archive without rebuilding or a language runtime on PATH.

Run inside each supported clean distribution with Python 3, OpenSSL and CA roots.
Only disposable local credentials and a loopback HTTPS fixture are used.
"""
import hashlib
import http.server
import json
from pathlib import Path
import platform
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading

archive = Path(sys.argv[1]).resolve()
version = sys.argv[2]
checksum = Path(str(archive) + ".sha256").read_text().split()
assert checksum == [hashlib.sha256(archive.read_bytes()).hexdigest(), archive.name], "Checksum mismatch"
assert sys.platform == "linux" and platform.machine() == "x86_64", "Only Linux x86-64 is qualified"

with tempfile.TemporaryDirectory(prefix="racr-artifact-") as directory:
    root = Path(directory)
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        assert len(members) == 1 and members[0].name == "racr" and members[0].isfile()
        binary = root / "racr"
        binary.write_bytes(bundle.extractfile(members[0]).read())
        binary.chmod(0o755)
    env = {"PATH": "", "HOME": directory, "RACR_CREDENTIAL_FILE": ""}

    def run(*args, secret="", expected=0):
        result = subprocess.run([str(binary), *map(str, args)], env=env, input=secret,
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == expected, (args, result.returncode, result.stderr)
        return result

    assert run("--version").stdout.strip() == version
    assert "racr" in run("account", "transfer", "--help").stdout
    assert json.loads(run("--unknown", expected=1).stderr)["error"]["code"] == "USAGE_ERROR"
    vault, recovery = root / "vault.json", root / "recovery.txt"
    run("vault", "create", "--vault", vault, "--recovery-file", recovery)
    assert vault.stat().st_mode & 0o777 == recovery.stat().st_mode & 0o777 == 0o600
    assert json.loads(run("vault", "verify", "--vault", vault, "--expected-did", "unbound",
                          secret=recovery.read_text()).stdout)["verified"] is True

    def openssl(*args):
        subprocess.run(["openssl", *map(str, args)], check=True, capture_output=True)

    ca, ca_key, cert, key, csr = [root / name for name in ("ca.pem", "ca.key", "cert.pem", "key.pem", "server.csr")]
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=racr-artifact-ca", "-addext", "basicConstraints=critical,CA:TRUE",
            "-keyout", ca_key, "-out", ca)
    openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
            "-keyout", key, "-out", csr)
    extensions = root / "extensions.cnf"
    extensions.write_text("subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n")
    openssl("x509", "-req", "-in", csr, "-CA", ca, "-CAkey", ca_key, "-CAcreateserial",
            "-days", "1", "-extfile", extensions, "-out", cert)
    account_id = "019a0000-0000-7000-8000-000000000001"
    token = "racr_" + "a" * 43
    requests = []

    class Provider(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            assert self.headers.get("Authorization") == "Bearer " + token
            requests.append(self.path)
            if self.path == "/api/v1/account":
                body = {"type": "racr.account", "version": 1, "provider": provider,
                        "accountId": account_id, "did": "did:plc:" + "a" * 24,
                        "address": "fixture@localhost", "migrationState": None,
                        "custodyProfile": "managed", "monitorVerificationMode": "strict-public-v1",
                        "managedProfileVersion": "hail-managed-custody-v1",
                        "identityPublicKey": "did:key:z123", "ownerRecoveryPublicKey": None,
                        "scopes": ["account:read", "messages:read"],
                        "credential": {"credentialId": account_id, "expiresAt": "2099-01-01T00:00:00Z"}}
            elif self.path.startswith("/api/v1/account/inbox"):
                body = {"messages": [], "next": None}
            else:
                self.send_error(404)
                return
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    provider = "https://localhost:" + str(server.server_port)
    credentials = root / "credentials.json"
    credentials.write_text(json.dumps({"type": "racr.api-credential", "version": 1,
                                     "provider": provider, "accountId": account_id, "token": token}))
    credentials.chmod(0o600)
    env["RACR_CREDENTIAL_FILE"] = str(credentials)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # A reachable provider with an untrusted certificate must fail closed.
        run("account", "show", expected=1)
        assert requests == [], "Untrusted TLS reached the authenticated handler"
        env["SSL_CERT_FILE"] = str(ca)
        account = json.loads(run("account", "show").stdout)
        assert account["accountId"] == account_id
        inbox = json.loads(run("inbox", "list", "--pages", "1").stdout)
        assert inbox["messages"] == []
        assert any(path.startswith("/api/v1/account/inbox") for path in requests)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    print(json.dumps({"version": version, "architecture": platform.machine(),
                      "libc": platform.libc_ver(), "os": Path("/etc/os-release").read_text(),
                      "archive_sha256": checksum[0], "vault": True, "https_account_inbox": True,
                      "untrusted_tls_rejected": True}))
