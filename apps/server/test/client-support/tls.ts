import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A real CA and server leaf: Rustls correctly rejects a CA certificate as a leaf. */
export async function createLocalTlsFixture(directory: string): Promise<void> {
  const path = (name: string) => join(directory, name);
  const run = async (args: string[]) => {
    const child = Bun.spawn(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, , error] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`TLS fixture failed: ${error}`);
  };
  await run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=hail-integration-ca", "-addext", "basicConstraints=critical,CA:TRUE",
    "-keyout", path("ca-key.pem"), "-out", path("ca.pem")]);
  await run(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
    "-keyout", path("key.pem"), "-out", path("server.csr")]);
  await writeFile(path("server.ext"), "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n");
  await run(["x509", "-req", "-in", path("server.csr"), "-CA", path("ca.pem"),
    "-CAkey", path("ca-key.pem"), "-CAcreateserial", "-days", "1",
    "-extfile", path("server.ext"), "-out", path("cert.pem")]);
}
