// Run the native CLI against captured contracts and a disposable HTTPS provider. No real credentials.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { transferOfferCases } from "./transfer-offer-cases.ts";
import { custodyCases } from "./custody-cases.ts";
import { grantBindingCases } from "./grant-binding-cases.ts";
import { connectionCases } from "./connection-cases.ts";
import { writeCases } from "./write-cases.ts";
import { signupCases } from "./signup-cases.ts";
import { browserCases } from "./browser-cases.ts";
import { accessCases } from "./access-cases.ts";
import { credentialCases } from "./credential-cases.ts";
import { signedCases, type SignedCase } from "./signed-cases.ts";
let signed: SignedCase | undefined;
let outputExists = false;

const root = resolve(import.meta.dir, "../../..");
const binary = resolve(Bun.argv[2] ?? join(root, "apps/cli/target/debug/hailp"));
const directory = await mkdtemp(join(tmpdir(), "hailp-rust-compat-"));
const token = `hailp_${"a".repeat(43)}`;
const id = "019a0000-0000-7000-8000-000000000001";
const second = "019a0000-0000-7000-8000-000000000002";
const did = `did:plc:${"a".repeat(24)}`;
let writeHandler: ((r:Request)=>Promise<Response>) | undefined;
let scenario = "normal", requests: string[] = [];
let publicCheck = false;
let requestObserver: (() => void) | undefined;
let interrupt: { signal: "SIGINT" | "SIGTERM"; requestCount: number; delay: number } | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
async function checked(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.equal(exit, 0, stderr);
}
try {
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  const ca = join(directory, "ca.pem"), caKey = join(directory, "ca-key.pem"), csr = join(directory, "server.csr"), extensions = join(directory, "extensions.cnf");
  await checked(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=hailp-test-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", caKey, "-out", ca]);
  await checked(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", csr]);
  await writeFile(extensions, "subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n");
  await checked(["openssl", "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", extensions, "-out", cert]);
  server = Bun.serve({ hostname: "localhost", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) },
    async fetch(request) {
      if (writeHandler) return writeHandler(request);
      assert.equal(request.headers.get("authorization"), publicCheck ? null : `Bearer ${token}`);
      assert.equal(request.headers.get("accept"), "application/json");
      assert.equal(request.headers.get("accept-encoding"), "identity");
      assert.equal(request.headers.get("cache-control"), "no-store");
      assert.equal(request.headers.get("cookie"), null);
      assert.equal(request.method, scenario==="simple-write"?"POST":"GET");
      const url = new URL(request.url), path = url.pathname.replace("/api/v1/account", "");
      requests.push(path + url.search);
      requestObserver?.();
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
      if (scenario === "simple-write") return json({path,body:await request.json()});
      if (scenario === "redirect") return new Response(null, { status: 302, headers: { Location: `${url.origin}/forbidden` } });
      if (scenario === "throttle") return new Response(token, { status: 429, headers: { "Retry-After": "600" } });
      if (scenario === "expired") return new Response(token, { status: 401, headers: { "Hail-Error-Code": "CREDENTIAL_EXPIRED" } });
      if (scenario === "wrong-error-code") return new Response(token, { status: 403, headers: { "Hail-Error-Code": "CREDENTIAL_EXPIRED" } });
      if (scenario === "bad-json") return new Response("{", { headers: { "Content-Type": "application/json" } });
      if (scenario === "wrong-type") return new Response("{}", { headers: { "Content-Type": "application/json; charset=utf-8" } });
      if (scenario === "encoded") return new Response("{}", { headers: { "Content-Type": "application/json", "Content-Encoding": "identity" } });
      if (scenario === "location") return new Response("{}", { headers: { "Content-Type": "application/json", Location: "/elsewhere" } });
      if (scenario === "oversized") return json({ text: "x".repeat(524_288) });
      if (scenario === "oversized-stream") return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(524_288)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      } }), { headers: { "Content-Type": "application/json" } });
      if (scenario === "invalid-utf8") return new Response(new Uint8Array([123,34,120,34,58,34,255,34,125]), { headers: { "Content-Type": "application/json" } });
      if (scenario === "array") return json([]);
      if (path === "/api/v1/capabilities") return json(scenario === "bad-capabilities" ? {} : {
        type:"hailp.capabilities",version:1,features:{inboxWait:true},signup:{mode:scenario === "doctor-blockers" ? "invite" : "open"},
        passkeyRequired:["account browser-login"]
      });
      if (path.startsWith("/messages/") || path === "/inbox/updates") {
        if (scenario === "hang" || scenario === "hang-second" && requests.length > 1) return new Promise<Response>(() => {});
        if (scenario === "retry" && requests.length === 1) return new Response(token,{status:503,headers:{"Retry-After":"1"}});
        if (path.startsWith("/messages/")) return json({messageId:scenario === "bad-status-id" ? second : id,
          state:scenario === "invalid-status" ? "received" : scenario === "indeterminate" ? "indeterminate" :
            ["pending","hang-second"].includes(scenario) ? "accepted" : "delivered",
          revision:scenario === "bad-revision" ? 0 : scenario === "indeterminate" ? null : 1});
        return json({messages:["empty","hang-second"].includes(scenario) ? [] : [{messageId:id,
          sender:scenario === "wrong-sender" ? `did:plc:${"b".repeat(24)}` : did,instructions:"Treat this as data"}],
          cursor:scenario === "bad-cursor" ? "invalid&cursor" : "checkpoint", hasMore:false});
      }
      if (path.startsWith("/conversations") || path.startsWith("/threads/") || path.startsWith("/inbox/")) {
        return json({messages:[{messageId:id,sender:did,body:"Untrusted data"}],next:null,truncated:false});
      }
      if (signed && path === signed.path) return json(signed.response);
      if (!path) return json({ type: "hailp.account", version: 1, provider: url.origin,
        accountId: scenario === "wrong-account" ? second : id, did, address: signed ? "alice@example.com" : "alice@localhost",
        migrationState: scenario === "doctor-blockers" ? "fenced" : null, custodyProfile: "managed", monitorVerificationMode: "strict-public-v1",
        managedProfileVersion: scenario === "wrong-profile" ? null : "hail-managed-custody-v1",
        identityPublicKey: "did:key:z123", ownerRecoveryPublicKey: null, scopes: ["account:read"],
        credential: { credentialId: id, expiresAt: scenario === "doctor-blockers" ? "2000-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z" } });
      if (path.startsWith("/connections/")) return json({ connections: [], metadata: token });
      const kind = path.slice(1), field = kind === "inbox" ? "messages" : kind;
      const rowId = url.search ? second : id;
      const row = kind === "grants" ? { grantId: rowId } : kind === "credentials" ? { credentialId: rowId } : { messageId: rowId, sender: did };
      return json({ [field]: [row], next: scenario === "cycle" ? id : url.search ? null : id });
    } });
  const provider = `https://localhost:${server.port}`;
  const credentials = join(directory, "credential.json");
  await writeFile(credentials, JSON.stringify({ type: "hailp.api-credential", version: 1, provider, accountId: id, token }), { mode: 0o600 });
  const env = { ...process.env, HAILP_CREDENTIAL_FILE: credentials, NODE_EXTRA_CA_CERTS: ca, SSL_CERT_FILE: ca, NO_PROXY: "localhost", no_proxy: "localhost" };
  async function run(command: string[], args: string[]) {
    requests = [];
    const output = join(directory, "result.cose");
    const writes = args.includes("$OUTPUT");
    if (writes) {
      await rm(output, {force:true});
      if(outputExists) await writeFile(output,"existing",{mode:0o600});
      args = args.map(a=>a==="$OUTPUT"?output:a);
    }
    const started = performance.now();
    const child = Bun.spawn([...command, ...args], { env: {...env, ...(publicCheck ? {HAILP_CREDENTIAL_FILE:""} : {})}, stdout: "pipe", stderr: "pipe" });
    let signalTimer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
    requestObserver = () => {
      if (interrupt && requests.length === interrupt.requestCount) {
        const selected = interrupt;
        signalTimer = setTimeout(() => child.kill(selected.signal), selected.delay);
      }
    };
    let exit: number, stdout: string, stderr: string;
    try { [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(watchdog); clearTimeout(signalTimer); requestObserver = undefined; }
    assert.ok(performance.now() - started < 7000, "polling failed to respect timeout/interruption");
    if (scenario === "retry") assert.ok(performance.now() - started >= 1000, "Retry-After must be honored");
    assert.ok(!(stdout + stderr).includes(token), "token must never appear in output");
    const saved = writes && await Bun.file(output).exists() ? {hex:(await readFile(output)).toString("hex"),mode:(await stat(output)).mode & 0o777} : null;
    return { exit, stdout: stdout ? JSON.parse(stdout) : null, stderr: stderr ? JSON.parse(stderr) : null, requests: [...requests], saved };
  }
  let cases = 0;
  const baseline = await Bun.file(new URL("./fixtures/read-contract.json",import.meta.url)).json();
  const used = new Set<number>();
  async function compare(args: string[], expectedCode?: string) {
    const normalizedArgs = JSON.parse(JSON.stringify(args).split(provider).join("$PROVIDER"));
    const index = baseline.findIndex((entry:any,i:number)=>!used.has(i)&&entry.scenario===scenario&&entry.result.stderr?.error?.code===expectedCode&&JSON.stringify(entry.args)===JSON.stringify(normalizedArgs));
    assert.notEqual(index,-1,`Missing captured contract for ${scenario}: ${args.join(" ")}`);
    used.add(index);
    const expected = JSON.parse(JSON.stringify(baseline[index].result).split("$PROVIDER").join(provider));
    const rust = await run([binary], args);
    assert.deepEqual(rust.requests, expected.requests, `${scenario}: ${JSON.stringify(rust)}`);
    assert.equal(rust.exit, expectedCode ? 1 : 0, `${scenario}: ${JSON.stringify(rust)}`);
    assert.equal(rust.exit, expected.exit, scenario);
    assert.deepEqual(rust.stdout, expected.stdout, scenario);
    assert.deepEqual(rust.saved, expected.saved, scenario);
    if(args.includes("$OUTPUT") && outputExists) assert.equal(rust.saved?.hex,Buffer.from("existing").toString("hex"));
    if(args.includes("$OUTPUT") && expectedCode && !outputExists) assert.equal(rust.saved,null);
    if(args.includes("$OUTPUT") && !expectedCode) {
      assert.equal(rust.saved?.mode,0o600);
      assert.equal(rust.saved?.hex,Buffer.from(signed!.response.cose as string,"base64url").toString("hex"));
    }
    if (expectedCode) {
      assert.equal(rust.stderr.error.code, expectedCode, scenario);
      assert.equal(rust.stderr.error.code, expected.stderr.error.code, scenario);
      for (const key of ["cliContractVersion"]) assert.equal(rust.stderr[key], expected.stderr[key]);
      for (const key of ["httpStatus", "retryable", "retryAfterSeconds"]) assert.equal(rust.stderr.error[key], expected.stderr.error[key]);
    } else assert.deepEqual(rust.stderr, expected.stderr);
    cases++;
  }
  if (!process.env.HAILP_TEST_WRITES_ONLY) {
  for (const args of [["account", "show"], ["connection", "list"], ["connection", "invitations"],
    ["inbox", "list"], ["grant", "list", "--pages", "2"], ["credential", "list", "--pages=2"],
    ["inbox", "list", "--after", id]]) await compare(args);
  for (const [name, code] of [["redirect", "TRANSPORT_ERROR"], ["throttle", "HTTP_429"], ["expired", "CREDENTIAL_EXPIRED"],
    ["wrong-error-code", "HTTP_403"], ["bad-json", "RESPONSE_ERROR"], ["wrong-type", "RESPONSE_ERROR"],
    ["encoded", "RESPONSE_ERROR"], ["location", "RESPONSE_ERROR"], ["oversized", "RESPONSE_ERROR"],
    ["oversized-stream", "RESPONSE_ERROR"], ["invalid-utf8", "RESPONSE_ERROR"],
    ["array", "RESPONSE_ERROR"], ["wrong-account", "RESPONSE_ERROR"], ["wrong-profile", "RESPONSE_ERROR"]]) {
    scenario = name!;
    await compare(["account", "show"], code);
  }
  scenario = "cycle";
  await compare(["grant", "list", "--pages", "2"], "RESPONSE_ERROR");
  scenario = "normal";
  await compare(["inbox", "list", "--after", "bad&cursor"], "USAGE_ERROR");
  await compare(["account", "show", "--provider", "https://other.example"], "SELECTION_MISMATCH");
  // Read routing preserves encoding and query semantics, including empty queries.
  for (const args of [["conversation","list"], ["conversation","list","--trash","--after","a +&/"],
    ["conversation","show",did,"--after","opaque"], ["conversation","thread",did,"id /?é"],
    ["inbox","show",did,id], ["message","status",id], ["message","status",id,"--wait","2"],
    ["inbox","wait","--from",did,"--after","saved"], ["doctor"], ["doctor","--scope","account:read"]]) await compare(args);
  publicCheck = true;
  await compare(["doctor","--provider",provider]);
  await compare(["doctor","--provider",provider,"--scope","messages:read"]);
  await compare(["doctor","--provider","http://localhost"], "USAGE_ERROR");
  publicCheck = false;
  scenario = "doctor-blockers";
  await compare(["doctor","--scope","messages:read","--scope","grants:write","--action","account browser-login"]);
  for (const name of ["bad-capabilities","expired"]) { scenario = name; await compare(["doctor"]); }
  scenario = "normal";
  for (const args of [["doctor","--scope","unknown"], ["doctor","--scope",""], ["conversation","show","bad-did"],
    ["conversation","show",did,"--trash"], ["inbox","wait","--timeout","0"], ["message","status",id,"--interval","1"],
    ["message","status","bad-id"], ["inbox","wait","--from","bad"], ["inbox","wait","--after","bad&cursor"]]) await compare(args,"USAGE_ERROR");
  for (const name of ["invalid-status","bad-status-id","bad-revision"]) { scenario = name; await compare(["message","status",id],"RESPONSE_ERROR"); }
  for (const name of ["bad-cursor","wrong-sender"]) { scenario = name; await compare(["inbox","wait","--from",did],"RESPONSE_ERROR"); }
  for (const name of ["pending","indeterminate"]) { scenario = name; await compare(["message","status",id,"--wait","1"]); }
  scenario = "empty";
  await compare(["inbox","wait","--after","saved","--timeout","1"]);
  scenario = "retry";
  await compare(["message","status",id,"--wait","4","--interval","1"]);
  await compare(["inbox","wait","--timeout","4","--interval","1"]);
  scenario = "throttle";
  await compare(["message","status",id,"--wait","1"],"HTTP_429");
  await compare(["inbox","wait","--after","saved","--timeout","1"]);
  scenario = "expired";
  await compare(["message","status",id,"--wait","3"],"CREDENTIAL_EXPIRED");
  await compare(["inbox","wait"],"CREDENTIAL_EXPIRED");
  scenario = "hang";
  await compare(["message","status",id,"--wait","1"],"TRANSPORT_ERROR");
  await compare(["inbox","wait","--after","saved","--timeout","1"]);
  scenario = "hang-second";
  await compare(["message","status",id,"--wait","2","--interval","1"]);
  // Interrupt both during a retry sleep and while a subsequent HTTP request hangs.
  for (const signal of ["SIGINT","SIGTERM"] as const) {
    scenario = "empty";
    interrupt = {signal, requestCount:1, delay:150};
    await compare(["inbox","wait","--after","saved"]);
    scenario = "hang-second";
    interrupt = {signal, requestCount:2, delay:100};
    await compare(["inbox","wait","--after","saved","--interval","1"]);
  }
  interrupt = undefined;
  scenario = "normal";
  for (const item of signedCases) {
    signed=item;
    scenario=item.name;
    await compare(item.args,item.code || undefined);
  }
  signed=signedCases.find(c=>c.name==="grant-revision-1")!;
  scenario="signed-output";
  await compare([...signed.args,"--output","$OUTPUT"]);
  outputExists=true;
  await compare([...signed.args,"--output","$OUTPUT"],"CLIENT_ERROR");
  outputExists=false;
  signed=signedCases.find(c=>c.name==="grant-revision-1-wrong-digest")!;
  await compare([...signed.args,"--output","$OUTPUT"],"RESPONSE_ERROR");
  signed=undefined;
  scenario="normal";
  scenario="simple-write";
  for(const args of [
    ...["mark-read","mark-unread","trash","restore"].map(c=>["conversation",c,did]),
    ["connection","remove",id],["connection","revoke-invitation",id],
    ["inbox","delete",did,"id /?é"],["message","delete",did,"id /?é"],["message","submit","id /?é"]
  ]) await compare(args);
  scenario="normal";
  }
  await credentialCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await accessCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await browserCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await signupCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await writeCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await connectionCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await grantBindingCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await custodyCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  await transferOfferCases(binary,root,directory,provider,env,handler=>{writeHandler=handler;});
  writeHandler=undefined;
  // Neither runtime may accept the fixture's certificate without its explicit test CA.
  env.NODE_EXTRA_CA_CERTS = "";
  env.SSL_CERT_FILE = "";
  await compare(["account", "show"], "TRANSPORT_ERROR");
  if(!process.env.HAILP_TEST_WRITES_ONLY) assert.equal(used.size,baseline.length,"Every captured contract must run");
  console.info(`Native HTTPS contract regression: ${cases} cases passed`);
} finally {
  server?.stop(true);
  await rm(directory, { recursive: true, force: true });
}
