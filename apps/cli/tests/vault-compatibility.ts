// Native vault regression with independent browser crypto/signing fixtures. Never reads user credentials.
import assert from "node:assert/strict";
import {fromDiagnosticJson} from "@hailproto/codec";
import { mkdtemp, rm, writeFile, readFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unlockUserVault } from "../../server/test/client-support/vault.ts";
import { createUserVault, verifyUserVault } from "../../../packages/hail-client-support/src/vault-crypto.ts";
const root = resolve(import.meta.dir, "../../..");
const binary = resolve(Bun.argv[2] ?? join(root, "apps/cli/target/debug/hailp"));
const directory = await mkdtemp(join(tmpdir(), "hailp-vault-compat-"));

let cases = 0;
async function run(command: string[], args: string[], secret = "", success = true) {
  const child = Bun.spawn([...command, ...args], { stdin: new Blob([secret + "\n"]), stdout: "pipe", stderr: "pipe", env: {...process.env, HAILP_CREDENTIAL_FILE: ""} });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(exit === 0, success, `${args.join(" ")}: ${stderr}`);
  if (secret) { assert(!stdout.includes(secret)); assert(!stderr.includes(secret)); }
  cases++;
  return success ? JSON.parse(stdout) : undefined;
}
try {
  for (const producer of [[binary]]) {
    const label = "native";
    const vault = join(directory, label + ".json"), recovery = join(directory, label + ".secret");
    await run(producer, ["vault", "create", "--vault", vault, "--recovery-file", recovery]);
    for (const path of [vault, recovery]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    const bytes = await readFile(vault), secret = (await readFile(recovery, "utf8")).trim();
    await verifyUserVault(JSON.parse(bytes.toString()), Buffer.from(secret, "base64url"));
    for (const [index, consumer] of [[binary]].entries()) {
      const verified = await run(consumer, ["vault", "verify", "--vault", vault, "--expected-did", "unbound"], secret);
      assert.equal(verified.verified, true);
      for (const operation of ["backup", "import"]) {
        const output = join(directory, `${label}-${index}-${operation}.json`);
        const args = operation === "backup" ? ["vault", "backup", "--vault", vault, "--output", output] : ["vault", "import", "--file", vault, "--vault", output, "--expected-did", "unbound"];
        await run(consumer, args, secret);
        assert.deepEqual(await readFile(output), bytes);
        assert.equal((await stat(output)).mode & 0o777, 0o600);
        await run(consumer, args, secret, false);
        assert.deepEqual(await readFile(output), bytes);
      }
      await run(consumer, ["vault", "verify", "--vault", vault], Buffer.alloc(32, 3).toString("base64url"), false);
      await run(consumer, ["vault", "verify", "--vault", vault, "--expected-did", `did:plc:${"a".repeat(24)}`], secret, false);
      for (const mutation of [
        (v: any) => v.extra = true,
        (v: any) => v.identity.role = "user-recovery",
        (v: any) => v.identity.nonce = "AA",
        (v: any) => v.recovery.ciphertext = "AA",
        (v: any) => v.identity.publicDidKey = v.recovery.publicDidKey,
        (v: any) => v.identity.ciphertext = "A" + v.identity.ciphertext.slice(1, -1) + "A",
      ]) {
        const value = JSON.parse(bytes.toString()); mutation(value);
        const bad = join(directory, "bad.json");
        await writeFile(bad, JSON.stringify(value), {mode: 0o600});
        await run(consumer, ["vault", "verify", "--vault", bad], secret, false);
      }
      await chmod(vault, 0o644);
      await run(consumer, ["vault", "verify", "--vault", vault], secret, false);
      await chmod(vault, 0o600);
    }
  }
  const created = await createUserVault();
  const source = join(directory, "web.json");
  await writeFile(source, JSON.stringify(created.vault), {mode: 0o600});
  await run([binary], ["vault", "verify", "--vault", source], Buffer.from(created.recoverySecret).toString("base64url"));
  const provider = await createUserVault(), messaging = await createUserVault();
  const user = await unlockUserVault(created.vault, created.recoverySecret);
  const genesis = await user.signManagedGenesis({type:"plc_operation", prev:null,
    rotationKeys:[created.vault.recovery.publicDidKey, provider.vault.recovery.publicDidKey],
    verificationMethods:{"hail-identity":provider.vault.identity.publicDidKey,"hail-messaging":messaging.vault.identity.publicDidKey},
    alsoKnownAs:[], services:{hail:{type:"HailMessaging",endpoint:"https://provider.example/hail"}}});
  const bound = {...created.vault, did:genesis.did};
  const recoveryPackage = {type:"hail.recovery-package",version:1,vault:bound,operation:genesis.operation,setup:"Fixture setup"};
  const packagePath = join(directory,"package.json");
  const secret = Buffer.from(created.recoverySecret).toString("base64url");
  for (const [index, consumer] of [[binary]].entries()) {
    await writeFile(packagePath,JSON.stringify(recoveryPackage),{mode:0o600});
    await run(consumer,["vault","verify","--vault",packagePath,"--expected-did",genesis.did],secret);
    const output = join(directory,`package-import-${index}.json`);
    await run(consumer,["vault","import","--file",packagePath,"--vault",output,"--expected-did",genesis.did],secret);
    assert.deepEqual(JSON.parse(await readFile(output,"utf8")),bound);
    for (const mutate of [
      (v:any)=>v.operation.services.hail.endpoint="https://evil.example",
      (v:any)=>v.vault.did=`did:plc:${"b".repeat(24)}`,
      (v:any)=>v.operation.rotationKeys.reverse(),
      (v:any)=>v.operation.extra=true,
      (v:any)=>v.operation.sig=Buffer.alloc(64).toString("base64url"),
    ]) {
      const bad=structuredClone(recoveryPackage);mutate(bad);
      await writeFile(packagePath,JSON.stringify(bad));
      await run(consumer,["vault","verify","--vault",packagePath],secret,false);
    }
  }
  await writeFile(source,JSON.stringify(bound));
  const fixtures=await Bun.file(join(root,"packages/hail-codec-ts/vectors/connections-draft.json")).json();
  for (const fixture of fixtures.positive.filter((v:any)=>["hail.connection-invitation","hail.connection-confirmation"].includes(v.type))) {
    const payload=structuredClone(fixture.diagnostic), now=Math.floor(Date.now()/1000);
    payload.from=genesis.did;payload.key_id=genesis.did+"#hail-identity";payload.issued_at=now;payload.expires_at=now+120;
    const proposal={type:"hailp.connection-signing",version:1,provider:"https://provider.example",requestId:"019a0000-0000-7000-8000-000000000001",expiresAt:new Date(Date.now()+120000).toISOString(),payload};
    const path=join(directory,"proposal.json");await writeFile(path,JSON.stringify(proposal),{mode:0o600});
    const outputs=[];
    for (const [index,consumer] of [[binary]].entries()) {
      const output=join(directory,`${fixture.id}-${index}.cbor`);
      const args=["connection","sign",path,"--vault",source,"--output",output,"--provider",proposal.provider];
      await run(consumer,args,secret);await run(consumer,args,secret);
      outputs.push(await readFile(output));
      await writeFile(output,"conflicting previous artifact");await run(consumer,args,secret,false);
      assert.equal(await readFile(output,"utf8"),"conflicting previous artifact");
      const expired={...proposal,expiresAt:new Date(0).toISOString()};await writeFile(path,JSON.stringify(expired));
      await run(consumer,args,secret,false);await writeFile(path,JSON.stringify(proposal));
    }
    const signer=await unlockUserVault(bound,created.recoverySecret);
    assert.deepEqual(outputs[0],Buffer.from(await signer.signConnectionConsent(fromDiagnosticJson(payload.type,payload))));
  }
  console.log(`Vault regression: ${cases} cases passed`);
} finally { await rm(directory, {recursive:true, force:true}); }
