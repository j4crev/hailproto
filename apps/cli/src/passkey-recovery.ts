import {createHash,randomBytes} from "node:crypto";
import {resolve} from "node:path";
import {decodeBase64Url,encodeBase64Url} from "@hailproto/codec";
import {AccountApiClient} from "./account-api.js";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import {writeState} from "./account-creation.js";
import {unlockUserIdentity,unlockUserVault,type UserVaultFile} from "./vault.js";
import {accountAccessInput,type AccountAccessChallenge} from "./account-access-proof.js";
import {readRecoverySecret} from "./cli/private-input.js";

interface RecoveryState {
  type:"hailp.passkey-recovery";version:1;provider:string;did:string;signer:"identity"|"owner-recovery";
  publicKey:string;token:string;createdAt:number;challenge?:AccountAccessChallenge;signature?:string;
}

export async function recoverPasskey(provider:string,did:string,signer:RecoveryState["signer"],vaultPath:string,statePath:string,output:string,
  recoveryInput:()=>Promise<string>=readRecoverySecret){
  if(new Set([vaultPath,statePath,output].map(path=>resolve(path))).size!==3||!/^did:plc:[a-z2-7]{24}$/.test(did)||!["identity","owner-recovery"].includes(signer))
    throw new Error("Passkey recovery requires distinct private paths and an explicit DID/signer");
  const vault=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(vaultPath,16_384))) as UserVaultFile;
  if(vault.did!==did)throw new Error("Recovery DID differs from the owner vault");
  const publicKey=signer==="identity"?vault.identity.publicDidKey:vault.recovery.publicDidKey;
  let state:RecoveryState;
  try{state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(statePath,16_384)));}
  catch(error){
    if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    state={type:"hailp.passkey-recovery",version:1,provider,did,signer,publicKey,
      token:`hailp_${encodeBase64Url(randomBytes(32))}`,createdAt:Math.floor(Date.now()/1000)};
    AccountApiClient.signup(provider,state.token);await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));
  }
  if(!state||state.type!=="hailp.passkey-recovery"||state.version!==1||state.provider!==provider||state.did!==did||
    state.signer!==signer||state.publicKey!==publicKey||!Number.isSafeInteger(state.createdAt)||
    state.createdAt>Math.floor(Date.now()/1000)+30||Math.floor(Date.now()/1000)-state.createdAt>=300)
    throw new Error("Recovery state differs or expired; retain it and start a deliberate new attempt with a new path");
  const client=AccountApiClient.signup(provider,state.token),tokenHash=encodeBase64Url(new Uint8Array(createHash("sha256").update(state.token).digest()));
  const secret=decodeBase64Url(await recoveryInput());
  try{
    const user=signer==="identity"?await unlockUserIdentity(vault,secret):await unlockUserVault(vault,secret);
    const challenge=state.challenge??await client.request("/prepare",{did,signer,publicKey,scopes:["credentials:write"],tokenHash,
      purpose:"passkey-enrollment"},"/api/v1/account-access") as unknown as AccountAccessChallenge;
    accountAccessInput(challenge);const now=Math.floor(Date.now()/1000);
    if(challenge.purpose!=="passkey-enrollment"||challenge.provider!==provider||challenge.did!==did||challenge.signer!==signer||
      challenge.publicKey!==publicKey||challenge.tokenHash!==tokenHash||JSON.stringify(challenge.scopes)!=='["credentials:write"]'||
      challenge.issuedAt>now+30||challenge.issuedAt<state.createdAt-30||challenge.expiresAt<=now)throw new Error("Challenge differs from reviewed recovery or expired");
    state.challenge=challenge;await writeState(statePath,state);
    if(!state.signature){state.signature=encodeBase64Url(signer==="identity"?
      await (user as Awaited<ReturnType<typeof unlockUserIdentity>>).signAccountAccess(challenge):
      await (user as Awaited<ReturnType<typeof unlockUserVault>>).signAccountRecovery(challenge));await writeState(statePath,state);}
    const result=await client.request("/complete",{challengeId:challenge.challengeId,token:state.token,signature:state.signature},"/api/v1/account-access"),
      enrollment=result.enrollment as Record<string,unknown>;
    if(!enrollment||enrollment.type!=="hailp.passkey-enrollment"||enrollment.version!==1||enrollment.provider!==provider||
      enrollment.accountId!==challenge.accountId||enrollment.token!==state.token||typeof enrollment.url!=="string"||
      typeof enrollment.expiresAt!=="string"||!Number.isFinite(Date.parse(enrollment.expiresAt)))throw new Error("Recovery acknowledgement differs from signed proof");
    const url=new URL(enrollment.url);
    if(url.origin!==provider||url.pathname!=="/auth/recover"||url.search||url.hash!==`#token=${state.token}`)
      throw new Error("Recovery URL differs from signed provider");
    try{await savePrivateBytes(output,new TextEncoder().encode(JSON.stringify(enrollment)));}
    catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error;
      const saved=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(output,16_384)));
      if(JSON.stringify(saved)!==JSON.stringify(enrollment))throw new Error("Recovery output conflicts with issued enrollment");}
    return {enrollmentFile:output,expiresAt:enrollment.expiresAt,did,signer};
  }finally{secret.fill(0);}
}
