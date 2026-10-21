import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createWebCryptoVerifier, decodeBase64Url, encodeBase64Url, inspectSignedPayload, verifySignedPayload, type HailAddressBinding } from "@hailproto/codec";
import { base58btc } from "multiformats/bases/base58";
import { AccountApiClient } from "./account-api.js";
import { privateFile,savePrivateBytes } from "./grant-revocation.js";
import { unlockUserIdentity,type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";

function checked(record:Record<string,unknown>) {
  if(record.type!=="hailp.address-binding"||record.version!==1||typeof record.cose!=="string"||record.cose.length>21846||
    typeof record.digest!=="string"||typeof record.bindingId!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(record.bindingId)||
    !["active","expired","superseded"].includes(record.status as string)||typeof record.renewalDue!=="boolean")throw new Error("Invalid binding response");
  const bytes=decodeBase64Url(record.cose),payload=inspectSignedPayload("hail.address-binding",bytes).payload;
  if(bytes.length>16384||encodeBase64Url(new Uint8Array(createHash("sha256").update(bytes).digest()))!==record.digest||record.expiresAt!==payload.expires_at)throw new Error("Binding response bytes/digest differ");
  return {record,bytes,payload};
}
export async function showBinding(client:AccountApiClient) {
  const account=await client.account(),current=checked(await client.request("/binding"));
  if(current.payload.did!==account.did||current.payload.address!==account.address)throw new Error("Binding belongs to another account");
  return {bindingId:current.record.bindingId,digest:current.record.digest,address:current.payload.address,did:current.payload.did,
    issuedAt:current.payload.issued_at,expiresAt:current.payload.expires_at,status:current.record.status,renewalDue:current.record.renewalDue};
}
interface State {provider:string;accountId:string;signingKey:string;previous:string;payload:HailAddressBinding;}
export async function renewBinding(client:AccountApiClient,output:string,expiresAt:number,vaultPath?:string,recoveryInput=readRecoverySecret) {
  const account=await client.account();
  if(account.migrationState||!account.scopes.includes("account:write")||!account.identityPublicKey)throw new Error("Account cannot renew its address");
  const managed=account.custodyProfile==="managed";
  if(managed&&vaultPath||!managed&&!vaultPath)throw new Error("Select managed signing without a vault or owner identity signing with a vault");
  const statePath=`${output}.request.json`;let state:State;
  try {state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(statePath,16384)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    const current=checked(await client.request("/binding"));
    if(current.payload.did!==account.did||current.payload.address!==account.address)throw new Error("Binding belongs to another account");
    const issuedAt=Math.max(Math.floor(Date.now()/1000),current.payload.issued_at+1);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=current.payload.expires_at||expiresAt<=issuedAt||expiresAt-issuedAt>90*86400)throw new Error("Renewal must extend expiry within 90 days of issuance");
    state={provider:account.provider,accountId:account.accountId,signingKey:account.identityPublicKey as string,previous:current.record.digest as string,
      payload:{type:"hail.address-binding",version:1,address:account.address,did:account.did,issued_at:issuedAt,expires_at:expiresAt,key_id:`${account.did}#hail-identity`}};
    await savePrivateBytes(statePath,new TextEncoder().encode(JSON.stringify(state)));}
  if(state.provider!==account.provider||state.accountId!==account.accountId||state.signingKey!==account.identityPublicKey||
    state.payload.address!==account.address||state.payload.did!==account.did||state.payload.key_id!==`${account.did}#hail-identity`||
    state.payload.expires_at!==expiresAt||state.payload.expires_at<=Math.floor(Date.now()/1000))throw new Error("Renewal request changed, key changed or artifact expired");
  let saved:Uint8Array|undefined;
  try {saved=await privateFile(output,16384);}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  const publicBytes=base58btc.decode(state.signingKey.slice(8));
  const verifier=createWebCryptoVerifier(async kid=>{if(kid!==state.payload.key_id)throw new Error("Wrong binding signer");
    return crypto.subtle.importKey("raw",Uint8Array.from(publicBytes.slice(2)),"Ed25519",false,["verify"]);});
  if(saved&&!isDeepStrictEqual((await verifySignedPayload("hail.address-binding",saved,verifier)).payload,state.payload))throw new Error("Signed artifact conflicts with renewal request");
  if(!managed&&!saved){const secret=decodeBase64Url(await recoveryInput());try{
    const user=await unlockUserIdentity(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath!,16384))) as UserVaultFile,secret);
    if(user.vault.did!==account.did||user.vault.identity.publicDidKey!==state.signingKey)throw new Error("Vault does not match the account identity");
    saved=await user.signAddressBinding(state.payload);await savePrivateBytes(output,saved);
  }finally{secret.fill(0);}}
  const response=checked(await client.request("/binding",{previous:state.previous,signingKey:state.signingKey,
    ...(managed?{payload:state.payload}:{cose:encodeBase64Url(saved!)})}));
  if(!isDeepStrictEqual((await verifySignedPayload("hail.address-binding",response.bytes,verifier)).payload,state.payload)||
    saved&&!Buffer.from(saved).equals(Buffer.from(response.bytes)))throw new Error("Provider did not retain the exact signed binding");
  if(!saved)await savePrivateBytes(output,response.bytes);
  return {bindingId:response.record.bindingId,digest:response.record.digest,expiresAt:response.record.expiresAt,status:response.record.status,
    renewalDue:response.record.renewalDue,signedFile:output};
}
