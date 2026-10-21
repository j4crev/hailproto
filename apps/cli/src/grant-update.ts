import { isDeepStrictEqual } from "node:util";
import { createWebCryptoVerifier, decodeBase64Url, encodeBase64Url, fromDiagnosticJson, inspectSignedPayload,
  verifySignedPayload, type DiagnosticJson } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import type { AccountApiClient } from "./account-api.js";
import { selectedScope,sameGrantValue } from "./grant-creation.js";
import { privateFile,savePrivateBytes } from "./grant-revocation.js";
import { writeState } from "./account-creation.js";
import { unlockUserIdentity,type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";

interface State {provider:string;accountId:string;key:string;grantId:string;base:string;scope:ReturnType<typeof selectedScope>;
  expiryChoice:number|null|"keep";refreshConsent:boolean;sender:string|null;proposal?:DiagnosticJson;}
export async function updateGrant(client:AccountApiClient,grantId:string,category:string[]|null,output:string,vaultPath?:string,
  expiresAt?:number|null,refreshConsent=false,sender?:string,recoveryInput=readRecoverySecret) {
  const account=await client.account(),scope=selectedScope(category),expiryChoice=expiresAt===undefined?"keep":expiresAt;
  if(account.migrationState||!account.scopes.includes("grants:write")||typeof account.identityPublicKey!=="string")throw new Error("Account cannot update Grants");
  const managed=account.custodyProfile==="managed";
  if(managed&&vaultPath||!managed&&!vaultPath)throw new Error("Select managed signing without a vault or owner signing with a vault");
  const path=`${output}.request.json`;let state:State;
  try{state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,524288)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    const current=await client.grant(grantId);
    if(current.localRole!=="grantor"||current.payload.grantor!==account.did||current.payload.status!=="active")throw new Error("Only an active authoritative lineage can be updated");
    state={provider:account.provider,accountId:account.accountId,key:account.identityPublicKey,grantId,base:encodeBase64Url(current.representation),
      scope,expiryChoice,refreshConsent,sender:sender ?? null};
    await savePrivateBytes(path,new TextEncoder().encode(JSON.stringify(state)));}
  if(state.provider!==account.provider||state.accountId!==account.accountId||state.key!==account.identityPublicKey||state.grantId!==grantId||
    !isDeepStrictEqual(state.scope,scope)||state.expiryChoice!==expiryChoice||state.refreshConsent!==refreshConsent||state.sender!==(sender ?? null))throw new Error("Grant update request or signing key changed");
  const baseBytes=decodeBase64Url(state.base),base=inspectSignedPayload("hail.grant",baseBytes).payload;
  const deadline=expiryChoice==="keep"?base.expires_at:expiryChoice;
  const verifier=createWebCryptoVerifier(async kid=>{if(kid!==`${account.did}#hail-identity`)throw new Error("Wrong Grant signer");
    return crypto.subtle.importKey("raw",Uint8Array.from(base58btc.decode(state.key.slice(8)).slice(2)),"Ed25519",false,["verify"]);});
  // This slice does not guess historical key authority when the predecessor's signer changed.
  await verifySignedPayload("hail.grant",baseBytes,verifier);
  if(!state.proposal){
    const digest=await crypto.subtle.digest("SHA-256",Uint8Array.from(baseBytes));
    const result=await client.request(`/grants/${grantId}/proposals`,{scope,expiresAt:deadline,refreshConsent,
      expectedRevision:base.revision,expectedDigest:encodeBase64Url(new Uint8Array(digest)),...(sender?{sender}:{})});
    if(result.type!=="hailp.grant-proposal"||result.version!==1)throw new Error("Invalid Grant proposal");
    state.proposal=result.grant as DiagnosticJson;await writeState(path,state);
  }
  const proposed=fromDiagnosticJson("hail.grant",state.proposal),digest=new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(baseBytes)));
  const oldScope=base.scope[0]!,subset=oldScope.type===scope.type&&(scope.type==="uncategorized"||oldScope.type==="categories"&&scope.values.every(v=>oldScope.values.includes(v)));
  const notExtended=base.expires_at===null||deadline!==null&&deadline<=base.expires_at;
  const restriction=subset&&notExtended&&(!sameGrantValue(base.scope,[scope])||deadline!==base.expires_at);
  if(proposed.grant_id!==grantId||proposed.grantor!==account.did||proposed.grantee!==base.grantee||proposed.issued_at!==base.issued_at||
    proposed.revision!==base.revision+1||!isDeepStrictEqual(proposed.previous,digest)||proposed.status!=="active"||
    proposed.updated_at<=base.updated_at||proposed.updated_at>Math.floor(Date.now()/1000)+300||proposed.key_id!==`${account.did}#hail-identity`||
    !sameGrantValue(proposed.scope,[scope])||proposed.expires_at!==deadline||
    restriction&&!sameGrantValue(proposed.consent_context,base.consent_context)||
    !restriction&&proposed.consent_context.grantee_address!==(sender ?? base.consent_context.grantee_address).toLowerCase())throw new Error("Proposal differs from the reviewed update");
  let signed:Uint8Array|undefined;
  try{signed=await privateFile(output,262144);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  if(signed&&!sameGrantValue((await verifySignedPayload("hail.grant",signed,verifier)).payload,proposed))throw new Error("Signed update conflicts with its request");
  if(!managed){
    if(!signed){const secret=decodeBase64Url(await recoveryInput());try{
      const user=await unlockUserIdentity(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath!,16384))) as UserVaultFile,secret);
      if(user.vault.did!==account.did||user.vault.identity.publicDidKey!==state.key)throw new Error("Vault does not match the account identity");
      signed=await user.signGrant(proposed);await savePrivateBytes(output,signed);
    }finally{secret.fill(0);}}
    return client.submit(signed);
  }
  const result=await client.request(`/grants/${grantId}/update`,{payload:state.proposal,signingKey:state.key});
  if(typeof result.cose!=="string"||result.cose.length>349528)throw new Error("Invalid managed signed update");
  const bytes=decodeBase64Url(result.cose),checked=await verifySignedPayload("hail.grant",bytes,verifier);
  if(!sameGrantValue(checked.payload,proposed)||signed&&!Buffer.from(signed).equals(Buffer.from(bytes))||
    result.grantId!==grantId||result.revision!==proposed.revision||result.status!=="active"||result.publication!=="durable"||
    result.digest!==encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(bytes)))))throw new Error("Managed acknowledgement differs from signed state");
  if(!signed)await savePrivateBytes(output,bytes);
  return {grantId,revision:proposed.revision,status:"active",digest:result.digest,publication:"durable"};
}
