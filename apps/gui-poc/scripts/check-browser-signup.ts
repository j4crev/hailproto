import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const bundle = await Bun.build({ entrypoints: [new URL("../src/lib/signup-recovery.ts", import.meta.url).pathname],
  target: "browser", minify: true });
assert(bundle.success, "Browser signup bundle failed");
const javascript = await bundle.outputs[0]!.text();
const nonce = crypto.randomUUID(), unexpected: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/vault.js") return new Response(javascript, { headers: { "content-type": "text/javascript" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path !== "/" || request.method !== "GET") { unexpected.push(request.method + " " + path); return new Response(null, { status: 404 }); }
  return new Response(`<!doctype html><body>RUNNING<script type="module" nonce="${nonce}">
    import {createSignupBackup,verifySignupBackup,encodeBase64Url,signSignupGenesis} from '/vault.js';
    try {
      const generated=await createSignupBackup();
      try {
        const text=JSON.stringify(generated.vault),secret=encodeBase64Url(generated.recoverySecret);
        await verifySignupBackup(text,secret,generated.vault);
        let rejected=false;
        try {await verifySignupBackup(text,'A'.repeat(43),generated.vault);} catch {rejected=true;}
        if(!rejected)throw new Error('Wrong secret accepted');
        const provider=await createSignupBackup(),messaging=await createSignupBackup();
        try {
          const expected={provider:'https://provider.example',address:'alice@provider.example',
            monitorOrigin:'https://monitor.example',monitorKey:messaging.vault.identity.publicDidKey};
          const signed=await signSignupGenesis(generated.vault,generated.recoverySecret,{
            accountId:'12345678-1234-1234-1234-123456789abc',address:expected.address,
            userRecoveryKey:generated.vault.recovery.publicDidKey,userIdentityKey:provider.vault.identity.publicDidKey,
            providerRotationKey:provider.vault.recovery.publicDidKey,providerMessagingKey:messaging.vault.identity.publicDidKey,
            sourceServiceBase:expected.provider+'/hail',custodyProfile:'managed',managedProfileVersion:'hail-managed-custody-v1',
            monitorOrigin:expected.monitorOrigin,monitorPublicKey:expected.monitorKey,monitorAssurance:'reduced-assurance-alpha-v1'
          },expected);
          if(!/^did:plc:[a-z2-7]{24}$/.test(signed.did)||!signed.cid.startsWith('b'))throw new Error('Invalid identity');
        } finally {provider.recoverySecret.fill(0);messaging.recoverySecret.fill(0);}
        document.body.textContent='PASS: browser generation, encrypted export, verification, genesis signing and wrong-secret refusal';
      } finally {generated.recoverySecret.fill(0);}
    } catch {document.body.textContent='FAIL: browser recovery check';}
  </script>`, { headers: { "content-type": "text/html", "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}'; connect-src 'none'; base-uri 'none'; form-action 'none'` } });
} });
const profile = await mkdtemp(join(process.env.OPENCODE_TMP_DIR || "/tmp/opencode", "hail-browser-proof-"));
try {
  const child = Bun.spawn([process.env.CHROMIUM || "chromium", "--headless", "--disable-gpu", "--disable-background-networking",
    "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--dump-dom",
    "--timeout=20000", "--virtual-time-budget=10000", server.url.toString()], { stdout: "pipe", stderr: "pipe" });
  const [html, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 0, `Chromium failed: ${stderr.slice(-1000)}`);
  assert(html.includes("PASS: browser generation"), "Real-browser recovery proof did not complete");
  assert.deepEqual(unexpected, [], "Recovery code made unexpected requests");
  console.info("PASS: Chromium signup recovery with network access blocked by CSP");
} finally { server.stop(true); await rm(profile, { recursive: true, force: true }); }
