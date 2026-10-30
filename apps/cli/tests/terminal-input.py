"""Exercise the real recovery prompt through a disposable Unix pseudo-terminal."""
import fcntl
import os
import pty
import select
import subprocess
import sys
import tempfile
import termios
import time

with tempfile.TemporaryDirectory(prefix="hailp-terminal-") as directory:
    vault, recovery = directory + "/vault", directory + "/secret"
    subprocess.run([sys.argv[1], "vault", "create", "--vault", vault,
                    "--recovery-file", recovery], check=True, capture_output=True)
    with open(recovery) as file:
        secret = file.read().strip()
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    child = subprocess.Popen([sys.argv[1], "vault", "verify", "--vault", vault],
                             stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
    output = b""
    try:
        deadline = time.monotonic() + 10
        sent = False
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                output += os.read(master, 65536)
            if not sent and b"Recovery secret (hidden):" in output:
                # The prompt can precede tcsetattr; wait until echo is disabled.
                if not termios.tcgetattr(slave)[3] & termios.ECHO:
                    os.write(master, secret.encode() + b"\n")
                    sent = True
            if child.poll() is not None:
                while select.select([master], [], [], 0)[0]:
                    output += os.read(master, 65536)
                break
        assert child.poll() == 0, output.decode(errors="replace")
        assert sent and secret.encode() not in output
        assert b'"verified":true' in output
        assert termios.tcgetattr(slave) == original, "terminal mode not restored"
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        os.close(master)
        os.close(slave)
print("Terminal recovery input: hidden input and terminal restoration passed")
