import {expect,it} from "vitest";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createSignupBackup,signSignupGenesis,encodeBase64Url} from "./signup-recovery.js";
import {makeRecoveryPackage,openRecoveryPackage} from "./signup-package.js";
import {pendingKey,setupToken,type PendingSignup} from "./signup.js";
import {extractRecoveryVault} from "../../../../packages/hail-client-support/src/recovery-package.js";
import {verifyVaultFile,copyVerifiedVault} from "../../../server/test/client-support/vault-backup.js";

it("one saved kit resumes exact signup and imports a v1 recovery vault offline, rejecting swapped or damaged material",async()=>{
  const [owner,provider,messaging]=await Promise.all([createSignupBackup(),createSignupBackup(),createSignupBackup()]);
  const dir=await mkdtemp(join(tmpdir(),"hail-package-"));
  try{
    const policy={provider:"https://provider.example",monitorOrigin:"https://monitor.example",monitorKey:messaging.vault.identity.publicDidKey};
    const address="alice@provider.example",secret=encodeBase64Url(owner.recoverySecret),key=await pendingKey(secret);
    const signed=await signSignupGenesis(owner.vault,owner.recoverySecret,{
      accountId:crypto.randomUUID(),address,userRecoveryKey:owner.vault.recovery.publicDidKey,userIdentityKey:provider.vault.identity.publicDidKey,
      providerRotationKey:provider.vault.recovery.publicDidKey,providerMessagingKey:messaging.vault.identity.publicDidKey,
      sourceServiceBase:policy.provider+"/hail",custodyProfile:"managed",managedProfileVersion:"hail-managed-custody-v1",
      monitorAssurance:"reduced-assurance-alpha-v1",monitorOrigin:policy.monitorOrigin,monitorPublicKey:policy.monitorKey
    },{...policy,address});
    const pending:PendingSignup={type:"hail.pending-signup",version:2,policy,signupId:crypto.randomUUID(),address,email:"alice@example.net",
      token:setupToken(),enrollmentToken:setupToken(),invitation:"invitation",vault:owner.vault,operation:signed.operation,did:signed.did};
    const text=await makeRecoveryPackage(pending,key);
    for(const value of [secret,pending.token,pending.enrollmentToken,pending.email])expect(text).not.toContain(value);
    expect((await openRecoveryPackage(text,secret,policy,pending)).pending).toEqual(pending);
    await expect(openRecoveryPackage(text,"A".repeat(43),policy)).rejects.toThrow();
    await expect(openRecoveryPackage(text,secret,{...policy,monitorKey:"changed"})).rejects.toThrow();
    await expect(openRecoveryPackage(text,secret,policy,{...pending,signupId:crypto.randomUUID()})).rejects.toThrow();
    const file=JSON.parse(text);
    for(const changed of [
      {...file,vault:{...file.vault,did:"did:plc:"+"a".repeat(24)}},
      {...file,operation:{...file.operation,sig:"A".repeat(86)}},
      {...file,vault:{...file.vault,recovery:{...file.vault.recovery,ciphertext:"AA"}}},
      {...file,setup:await (await import("./signup.js")).sealPending({...pending,token:setupToken()},key)},
    ])await expect(openRecoveryPackage(JSON.stringify(changed),secret,policy,pending)).rejects.toThrow();
    const source=join(dir,"kit.json"),output=join(dir,"vault.json");
    await writeFile(source,text,{mode:0o600});
    expect((await verifyVaultFile(source,owner.recoverySecret,signed.did)).verified).toBe(true);
    await copyVerifiedVault(source,output,owner.recoverySecret,signed.did);
    expect(JSON.parse(await readFile(output,"utf8"))).toEqual({...owner.vault,did:signed.did});
    // Expired/retired setup authority and even damaged resume data do not prevent
    // offline extraction of independently verified owner recovery material.
    expect(await extractRecoveryVault(JSON.stringify({...file,setup:"expired"}),owner.recoverySecret)).toEqual({...owner.vault,did:signed.did});
    await expect(copyVerifiedVault(source,output,owner.recoverySecret,signed.did)).rejects.toThrow();
  }finally{for(const item of [owner,provider,messaging])item.recoverySecret.fill(0);await rm(dir,{recursive:true,force:true});}
});
