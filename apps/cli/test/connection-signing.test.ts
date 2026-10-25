import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect,it,vi} from "vitest";
import {encodeBase64Url,toDiagnosticJson,inspectSignedPayload,type HailConnectionInvitation} from "@hailproto/codec";
import {createUserVault,unlockUserVault} from "../src/vault.js";
import {signConnectionProposal} from "../src/connection-signing.js";
import {parseCommand} from "../src/cli/options.js";
const input=vi.hoisted(()=>({secret:""}));
vi.mock("../src/cli/private-input.js",()=>({readRecoverySecret:async()=>input.secret}));

it("signs exact offline connection consent with identity only, preserves retries and rejects provider/purpose substitution",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"hail-connection-signing-")),generated=await createUserVault(),log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{
    const vault=structuredClone(generated.vault);vault.did="did:plc:"+"a".repeat(24);vault.recovery.ciphertext="AA";
    await expect(unlockUserVault(vault,generated.recoverySecret)).rejects.toThrow();
    input.secret=encodeBase64Url(generated.recoverySecret);
    const now=Math.floor(Date.now()/1000),payload:HailConnectionInvitation={type:"hail.connection-invitation",version:1,
      invitation_id:"01954144-8097-7a9d-a7a8-ef29a823eaf1",from:vault.did,token_hash:{algorithm:"sha-256",value:new Uint8Array(32)},
      issued_at:now,expires_at:null,key_id:vault.did+"#hail-identity"};
    const proposal={type:"hailp.connection-signing",version:1,provider:"https://provider.example.com",requestId:payload.invitation_id,
      expiresAt:new Date(Date.now()+300000).toISOString(),payload:toDiagnosticJson(payload.type,payload)};
    const vaultPath=join(dir,"vault.json"),proposalPath=join(dir,"proposal.json"),output=join(dir,"consent.cose");
    await writeFile(vaultPath,JSON.stringify(vault),{mode:0o600});await writeFile(proposalPath,JSON.stringify(proposal),{mode:0o600});
    expect(parseCommand(["connection","sign",proposalPath,"--vault",vaultPath,"--output",output,"--provider",proposal.provider]).authenticated).toBe(false);
    await signConnectionProposal(vaultPath,proposalPath,output,proposal.provider);
    const before=new Uint8Array(await readFile(output));expect(inspectSignedPayload(payload.type,before).payload).toEqual(payload);
    await signConnectionProposal(vaultPath,proposalPath,output,proposal.provider);expect(new Uint8Array(await readFile(output))).toEqual(before);
    await expect(signConnectionProposal(vaultPath,proposalPath,output,"https://different.example.com")).rejects.toThrow("expected provider");
    await writeFile(proposalPath,JSON.stringify({...proposal,payload:{type:"hail.grant"}}),{mode:0o600});
    await expect(signConnectionProposal(vaultPath,proposalPath,output,proposal.provider)).rejects.toThrow("Only connection");
    await writeFile(proposalPath,JSON.stringify({...proposal,payload:toDiagnosticJson(payload.type,{...payload,from:"did:plc:"+"b".repeat(24),key_id:"did:plc:"+"b".repeat(24)+"#hail-identity"})}),{mode:0o600});
    await expect(signConnectionProposal(vaultPath,proposalPath,output,proposal.provider)).rejects.toThrow("signer DID");
  }finally{input.secret="";generated.recoverySecret.fill(0);log.mockRestore();await rm(dir,{recursive:true,force:true});}
});
