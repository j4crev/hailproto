import {createHash,randomUUID} from "node:crypto";
import {isIP} from "node:net";
import {domainToASCII} from "node:url";
import {cidForCbor} from "@atproto/common";
import {def} from "@did-plc/lib";
import * as dagCbor from "@ipld/dag-cbor";
import {decodeBase64Url,decodeDeterministic,encodeBase64Url,encodeDeterministic} from "@hailproto/codec";
import {base58btc} from "multiformats/bases/base58";
import {AccountApiClient} from "./account-api.js";
import {privateFile,savePrivateBytes} from "./grant-revocation.js";
import {writeState} from "./account-creation.js";
import {unlockUserIdentity,type UserTransferGrant,type UserTransferCancellation,type UserTransferAddressSelection,type UserVaultFile} from "./vault.js";
import {readRecoverySecret} from "./cli/private-input.js";
import {signPrivatePocCutover,verifyTransferSnapshot,verifySignature} from "./transfer-cutover.js";

interface Wire {payload:string;signature:string;}
interface State {type:"hailp.account-transfer";version:1;provider:string;accountId:string;did:string;key:string;destination:string;
  grant?:Wire;offer?:Wire;selection?:Wire;reservation?:Wire;cancellation?:Wire;receipt?:Wire;sourceMessagingKey?:string;targetAcknowledged?:boolean;
  cutover?:{snapshotDigest:string;consentPath:string;operationPath:string;bindingPath:string;operationCid?:string};activationReceipt?:Wire;retired?:boolean;}
const sha=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const equal=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const uuid=(value:unknown)=>typeof value==="string"&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const digest=(value:unknown)=>value instanceof Uint8Array&&value.length===32;
function record(value:unknown):Wire {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==2||!("payload" in value)||!("signature" in value)||
    typeof value.payload!=="string"||typeof value.signature!=="string"||decodeBase64Url(value.payload).length>4096||decodeBase64Url(value.signature).length!==64)throw new Error("Invalid bounded transfer representation");
  return {payload:value.payload,signature:value.signature};
}
async function verify(signed:Wire,kind:string,key:string) {
  if(typeof key!=="string"||!key.startsWith("did:key:z"))throw new Error("Expected an Ed25519 transfer key");
  const raw=base58btc.decode(key.slice(8));if(raw.length!==34||raw[0]!==0xed||raw[1]!==1)throw new Error("Expected an Ed25519 transfer key");
  const bytes=decodeBase64Url(signed.payload),tag=new TextEncoder().encode(`${kind}.v1\0`),input=new Uint8Array(tag.length+bytes.length);
  input.set(tag);input.set(bytes,tag.length);
  if(!await crypto.subtle.verify("Ed25519",await crypto.subtle.importKey("raw",Uint8Array.from(raw.slice(2)),"Ed25519",false,["verify"]),
    Uint8Array.from(decodeBase64Url(signed.signature)),input))throw new Error("Transfer signature differs from its expected key");
  const value=decodeDeterministic(bytes) as Record<string,any>;
  const fields=["type","version","did","nonce","issued_at","expires_at",...(kind==="hail.transfer-grant"?
    ["source_service_base","destination_service_base","destination_domain"]:kind==="hail.transfer-offer"?
    ["transfer_id","source_service_base","destination_service_base","grant_digest","invitation_digest","invitation_challenge","destination_rotation_key","destination_messaging_key"]:
    kind==="hail.transfer-address-selection"?["transfer_id","grant_digest","offer_digest","address","selection_nonce"]:
    kind==="hail.transfer-reservation"?["transfer_id","offer_digest","selection_digest","address"]:
    kind==="hail.transfer-cancellation"?["grant_digest"]:["grant_digest","invitation_digest","destination_domain","source_service_base"])];
  if(!value||typeof value!=="object"||Object.keys(value).length!==fields.length||!fields.every(k=>Object.hasOwn(value,k))||
    value.type!==kind||value.version!==1||typeof value.did!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(value.did)||!uuid(value.nonce)||
    !Number.isSafeInteger(value.issued_at)||!Number.isSafeInteger(value.expires_at)||value.expires_at<=value.issued_at||
    value.expires_at-value.issued_at>(kind==="hail.transfer-cancellation-receipt"?7*86400:3600)||value.issued_at>Math.floor(Date.now()/1000)+300||
    !["hail.transfer-grant","hail.transfer-reservation"].includes(kind)&&!digest(value.grant_digest)||
    ["hail.transfer-address-selection","hail.transfer-reservation"].includes(kind)&&(!uuid(value.transfer_id)||!digest(value.offer_digest)||typeof value.address!=="string"||
      (kind==="hail.transfer-address-selection"?!uuid(value.selection_nonce):!digest(value.selection_digest)))||
    !equal(bytes,encodeDeterministic(value)))throw new Error("Invalid transfer handshake fields");
  return value;
}
export function destinationOrigin(input:string) {
  const url=new URL(input),domain=domainToASCII(url.hostname);
  if(url.protocol!=="https:"||url.origin!==input||url.port||url.username||url.password||url.search||url.hash||domain!==url.hostname||
    isIP(domain)||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain)||domain.split(".").some(p=>p.startsWith("-")||p.endsWith("-")))throw new Error("Select a canonical public HTTPS provider domain without a port/path");
  return input;
}
async function reviewGrant(state:State) {
  const grant=await verify(record(state.grant),"hail.transfer-grant",state.key);
  if(grant.did!==state.did||grant.source_service_base!==`${state.provider}/hail`||grant.destination_service_base!==`${destinationOrigin(state.destination)}/hail`||
    grant.destination_domain!==new URL(state.destination).hostname)throw new Error("Retained approval differs from the transfer review");
  return grant;
}
async function reviewOffer(state:State,grant:Record<string,any>) {
  const offerWire=record(state.offer),raw=decodeDeterministic(decodeBase64Url(offerWire.payload)) as Record<string,any>;
  const offer=await verify(offerWire,"hail.transfer-offer",raw.destination_messaging_key);
  if(offer.did!==state.did||offer.nonce!==grant.nonce||offer.source_service_base!==grant.source_service_base||
    offer.destination_service_base!==grant.destination_service_base||offer.expires_at<=Math.floor(Date.now()/1000)||offer.expires_at>grant.expires_at||
    !equal(offer.grant_digest,sha(decodeBase64Url(state.grant!.payload)))||!digest(offer.invitation_challenge)||!digest(offer.invitation_digest)||
    !uuid(offer.transfer_id)||typeof offer.destination_rotation_key!=="string"||!offer.destination_rotation_key.startsWith("did:key:z")||
    offer.destination_rotation_key===offer.destination_messaging_key)throw new Error("Offer differs from the reviewed DID, destination or approval");
  return offer;
}
async function targetRequest(destination:string,operation:"reservations"|"cancellations"|"completions"|"retirements",body:unknown,transport:typeof fetch) {
  const response=await transport(`${destinationOrigin(destination)}/.well-known/hail/transfers/${operation}`,{method:"POST",redirect:"error",credentials:"omit",
    signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/hail-transfer+json","Accept-Encoding":"identity","Cache-Control":"no-store"},body:JSON.stringify(body)});
  const declared=response.headers.get("content-length");
  const empty=operation==="cancellations"||operation==="retirements";
  if(!(empty?response.status===204:operation==="completions"?response.status===200:[200,202].includes(response.status))||response.headers.has("location")||response.headers.has("content-encoding")||
    declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>16384)||!empty&&response.headers.get("content-type")!=="application/hail-transfer+json") {
    void response.body?.cancel();throw new Error(`Destination ${operation} response invalid (HTTP ${response.status}); retain and retry the exact transfer state`);
  }
  if(empty){void response.body?.cancel();return {status:response.status,record:null as unknown};}
  const reader=response.body?.getReader();if(!reader)throw new Error("Missing destination receipt");
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16384)throw new Error("Destination receipt exceeds limit");chunks.push(next.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {status:response.status,record:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown};
}
export async function transferStatus(client:AccountApiClient) {
  const account=await client.account(),status=await client.request("/transfers");
  if(status.type!=="hailp.transfer-status"||status.version!==1||status.provider!==account.provider||status.accountId!==account.accountId||status.did!==account.did||
    !["none","invitation-pending","offer-ready","expired","expired-unresolved","cancelled","fenced","exported","retired"].includes(status.phase as string))throw new Error("Transfer status differs from its authenticated account");
  return status;
}
export async function transferOffer(client:AccountApiClient,destination:string,vaultPath:string,path:string,recoveryInput=readRecoverySecret) {
  destination=destinationOrigin(destination);const account=await client.account();
  if(account.custodyProfile!=="owner-controlled"||account.migrationState||!account.scopes.includes("account:write")||typeof account.identityPublicKey!=="string"||destination===account.provider)throw new Error("Offer preparation requires owner-controlled write authority and a distinct destination");
  let state:State;
  try {state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;
    state={type:"hailp.account-transfer",version:1,provider:account.provider,accountId:account.accountId,did:account.did,key:account.identityPublicKey,destination};
    await savePrivateBytes(path,new TextEncoder().encode(JSON.stringify(state)));}
  if(!state||state.type!=="hailp.account-transfer"||state.version!==1||state.provider!==account.provider||state.accountId!==account.accountId||
    state.did!==account.did||state.key!==account.identityPublicKey||state.destination!==destination||state.cancellation)throw new Error("Transfer state/identity/destination changed or was cancelled");
  if(!state.grant){const secret=decodeBase64Url(await recoveryInput());try {
    const user=await unlockUserIdentity(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
    if(user.vault.did!==account.did||user.vault.identity.publicDidKey!==state.key)throw new Error("Vault does not match the account identity");
    const now=Math.floor(Date.now()/1000),grant:UserTransferGrant={type:"hail.transfer-grant",version:1,did:state.did,nonce:randomUUID(),
      source_service_base:`${account.provider}/hail`,destination_service_base:`${destination}/hail`,destination_domain:new URL(destination).hostname,issued_at:now,expires_at:now+3600};
    const signed=await user.signTransferGrant(grant);state.grant={payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)};await writeState(path,state);
  }finally{secret.fill(0);}}
  const grant=await verify(record(state.grant),"hail.transfer-grant",state.key),now=Math.floor(Date.now()/1000);
  if(grant.type!=="hail.transfer-grant"||grant.version!==1||grant.did!==state.did||grant.source_service_base!==`${account.provider}/hail`||
    grant.destination_service_base!==`${destination}/hail`||grant.destination_domain!==new URL(destination).hostname||grant.expires_at<=now||grant.expires_at-grant.issued_at>3600)throw new Error("Retained transfer approval is stale or differs from the review");
  const status=await client.request("/transfers/offer",{...state.grant});
  if(status.type!=="hailp.transfer-status"||status.version!==1||status.did!==state.did||status.accountId!==state.accountId||status.provider!==state.provider||
    status.nonce!==grant.nonce||status.destinationServiceBase!==grant.destination_service_base)throw new Error("Offer response does not match the signed approval");
   if(!status.offer){if(status.phase!=="invitation-pending")throw new Error("Transfer is no longer awaiting an Offer");return {did:state.did,destination,pending:true,stateFile:path};}
  if(status.originConfirmed!==true||status.phase!=="offer-ready")throw new Error("Source has not retained a current destination-origin Offer");
  const offerWire=record(status.offer),offer=await reviewOffer({...state,offer:offerWire},grant);
  if(state.offer&&(!equal(decodeBase64Url(state.offer.payload),decodeBase64Url(offerWire.payload))||state.offer.signature!==offerWire.signature))throw new Error("Destination Offer changed; retain original state for review");
  state.offer=offerWire;await writeState(path,state);
  return {did:state.did,destination,transferId:offer.transfer_id,expiresAt:offer.expires_at,
    destinationRotationPublicKey:offer.destination_rotation_key,destinationMessagingPublicKey:offer.destination_messaging_key,phase:"offer-ready",stateFile:path};
}
export async function selectTransferAddress(client:AccountApiClient,username:string,vaultPath:string,path:string,recoveryInput=readRecoverySecret,transport:typeof fetch=fetch) {
  if(username.length>63||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(username)||username.includes("..")||
    username.split(".").some(label=>label.startsWith("-")||label.endsWith("-")))throw new Error("Username must be a canonical Hail local part");
  const account=await client.account(),state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768))) as State;
  if(account.custodyProfile!=="owner-controlled"||!account.scopes.includes("account:write")||state.type!=="hailp.account-transfer"||state.version!==1||
    state.provider!==account.provider||state.accountId!==account.accountId||state.did!==account.did||state.key!==account.identityPublicKey||state.cancellation||
    account.migrationState&&!state.selection)throw new Error("Address selection requires the original owner-controlled source Offer");
  const grant=await reviewGrant(state),offer=await reviewOffer(state,grant),address=`${username}@${grant.destination_domain}`;
  const status=await transferStatus(client);
  if(status.originConfirmed!==true||status.nonce!==grant.nonce||status.transferId!==offer.transfer_id||status.destinationServiceBase!==grant.destination_service_base||
    !["offer-ready",...(state.selection?["fenced","exported"]:[])].includes(status.phase as string)||
    JSON.stringify(record(status.offer))!==JSON.stringify(record(state.offer)))throw new Error("Source no longer retains this exact live transfer Offer");
  if(!state.selection){const secret=decodeBase64Url(await recoveryInput());try {
    const user=await unlockUserIdentity(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
    if(user.vault.did!==state.did||user.vault.identity.publicDidKey!==state.key)throw new Error("Wrong address-selection signer");
    const now=Math.floor(Date.now()/1000),selection:UserTransferAddressSelection={type:"hail.transfer-address-selection",version:1,did:state.did,nonce:grant.nonce,
      transfer_id:offer.transfer_id,grant_digest:sha(decodeBase64Url(state.grant!.payload)),offer_digest:sha(decodeBase64Url(state.offer!.payload)),address,
      selection_nonce:randomUUID(),issued_at:now,expires_at:Math.min(now+1800,offer.expires_at,grant.expires_at)};
    const signed=await user.signTransferAddressSelection(selection);state.selection={payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)};await writeState(path,state);
  }finally{secret.fill(0);}}
  const selection=await verify(record(state.selection),"hail.transfer-address-selection",state.key);
  if(selection.did!==state.did||selection.nonce!==grant.nonce||selection.transfer_id!==offer.transfer_id||selection.address!==address||
    selection.expires_at<=Math.floor(Date.now()/1000)||selection.expires_at>offer.expires_at||
    !equal(selection.grant_digest,sha(decodeBase64Url(state.grant!.payload)))||!equal(selection.offer_digest,sha(decodeBase64Url(state.offer!.payload))))throw new Error("Retained selection is stale or differs from the reviewed address/Offer");
  const result=await targetRequest(state.destination,"reservations",state.selection,transport),receipt=record(result.record);
  const reservation=await verify(receipt,"hail.transfer-reservation",offer.destination_messaging_key);
  if(reservation.did!==state.did||reservation.nonce!==grant.nonce||reservation.transfer_id!==offer.transfer_id||reservation.address!==address||
    reservation.expires_at<=Math.floor(Date.now()/1000)||reservation.expires_at>selection.expires_at||
    !equal(reservation.offer_digest,selection.offer_digest)||!equal(reservation.selection_digest,sha(decodeBase64Url(state.selection.payload))))throw new Error("Destination reservation differs from the signed selection");
  if(state.reservation&&(state.reservation.payload!==receipt.payload||state.reservation.signature!==receipt.signature))throw new Error("Destination reservation receipt changed");
  state.reservation=receipt;await writeState(path,state);
  return {did:state.did,destination:state.destination,address,transferId:offer.transfer_id,requestAcknowledged:result.status===200,stateFile:path};
}
export async function cancelTransfer(client:AccountApiClient,vaultPath:string,path:string,recoveryInput=readRecoverySecret,transport:typeof fetch=fetch) {
  const account=await client.account(),state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768))) as State;
  if(account.custodyProfile!=="owner-controlled"||account.migrationState||!account.scopes.includes("account:write")||state.type!=="hailp.account-transfer"||state.version!==1||
    state.provider!==account.provider||state.accountId!==account.accountId||state.did!==account.did||state.key!==account.identityPublicKey||!state.grant)throw new Error("Cancellation requires the original owner-controlled source approval");
  const grant=await reviewGrant(state);
  if(!state.cancellation){const secret=decodeBase64Url(await recoveryInput());try {
    const user=await unlockUserIdentity(JSON.parse(new TextDecoder().decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
    if(user.vault.did!==state.did||user.vault.identity.publicDidKey!==state.key)throw new Error("Wrong cancellation signer");
    const now=Math.floor(Date.now()/1000),value:UserTransferCancellation={type:"hail.transfer-cancellation",version:1,did:state.did,nonce:grant.nonce,
      grant_digest:sha(decodeBase64Url(state.grant.payload)),issued_at:now,expires_at:now+3600};
    const signed=await user.signTransferCancellation(value);state.cancellation={payload:encodeBase64Url(signed.payloadBytes),signature:encodeBase64Url(signed.signature)};await writeState(path,state);
  }finally{secret.fill(0);}}
  const cancellation=await verify(record(state.cancellation),"hail.transfer-cancellation",state.key);
  if(cancellation.did!==state.did||cancellation.nonce!==grant.nonce||!equal(cancellation.grant_digest,sha(decodeBase64Url(state.grant.payload)))||
    !(state.receipt&&state.sourceMessagingKey)&&cancellation.expires_at<=Math.floor(Date.now()/1000))throw new Error("Retained cancellation is stale or differs from the approval");
  const result=state.receipt&&state.sourceMessagingKey?{type:"hailp.transfer-cancellation",version:1,cancelled:true,receipt:state.receipt,sourceMessagingPublicKey:state.sourceMessagingKey}:
    await client.request("/transfers/cancel",{...state.cancellation});
  if(result.type!=="hailp.transfer-cancellation"||result.version!==1||result.cancelled!==true)throw new Error("Source did not retain cancellation");
  const receipt=record(result.receipt);
  if(typeof result.sourceMessagingPublicKey!=="string")throw new Error("Cancellation receipt has no source operational key");
  const value=await verify(receipt,"hail.transfer-cancellation-receipt",result.sourceMessagingPublicKey);
  if(value.type!=="hail.transfer-cancellation-receipt"||value.version!==1||value.did!==state.did||value.nonce!==grant.nonce||
    value.source_service_base!==`${state.provider}/hail`||value.destination_domain!==new URL(state.destination).hostname||
     value.expires_at<=Math.floor(Date.now()/1000)||!digest(value.invitation_digest)||!equal(value.grant_digest,sha(decodeBase64Url(state.grant.payload)))||
     state.offer&&!equal(value.invitation_digest,(decodeDeterministic(decodeBase64Url(record(state.offer).payload)) as Record<string,any>).invitation_digest))throw new Error("Cancellation receipt does not match the original transfer");
  if(state.receipt&&(state.receipt.payload!==receipt.payload||state.receipt.signature!==receipt.signature))throw new Error("Cancellation receipt changed");
  state.receipt=receipt;state.sourceMessagingKey=result.sourceMessagingPublicKey;await writeState(path,state);
  try {await targetRequest(state.destination,"cancellations",{cancellation:state.cancellation,receipt},transport);}
  catch(error){throw new Error(`Source cancelled; target cleanup is unconfirmed: ${error instanceof Error?error.message:"transport failed"}. Retry the exact transfer state`);}
  state.targetAcknowledged=true;await writeState(path,state);
  return {did:state.did,destination:state.destination,cancelled:true,targetAcknowledged:true,stateFile:path};
}

async function retainedSelection(state:State) {
  const grant=await reviewGrant(state),raw=decodeDeterministic(decodeBase64Url(record(state.offer).payload)) as Record<string,any>;
  const offer=await verify(record(state.offer),"hail.transfer-offer",raw.destination_messaging_key);
  const selection=await verify(record(state.selection),"hail.transfer-address-selection",state.key);
  const reservation=await verify(record(state.reservation),"hail.transfer-reservation",offer.destination_messaging_key);
  if(state.cancellation||offer.did!==state.did||offer.nonce!==grant.nonce||offer.source_service_base!==grant.source_service_base||offer.destination_service_base!==grant.destination_service_base||
    selection.did!==state.did||selection.nonce!==grant.nonce||selection.transfer_id!==offer.transfer_id||reservation.did!==state.did||reservation.nonce!==grant.nonce||
    reservation.transfer_id!==offer.transfer_id||selection.address!==reservation.address||selection.address.split("@")[1]!==grant.destination_domain||
    !equal(offer.grant_digest,sha(decodeBase64Url(state.grant!.payload)))||!equal(selection.grant_digest,offer.grant_digest)||
    !equal(selection.offer_digest,sha(decodeBase64Url(state.offer!.payload)))||!equal(reservation.offer_digest,selection.offer_digest)||
    !equal(reservation.selection_digest,sha(decodeBase64Url(state.selection!.payload))))throw new Error("Retained transfer selection/reservation differs from the exact approval");
  return {offer,selection,reservation};
}
function snapshotMatches(manifest:Record<string,unknown>,state:State,offer:Record<string,any>) {
  if(![2,3].includes(manifest.version as number)||manifest.custodyProfile!=="portable"||manifest.did!==state.did||manifest.accountId!==state.accountId||manifest.transferId!==offer.transfer_id||
    manifest.sourceServiceBase!==`${state.provider}/hail`||manifest.destinationServiceBase!==`${state.destination}/hail`||
    manifest.destinationRotationPublicKey!==offer.destination_rotation_key||manifest.destinationMessagingPublicKey!==offer.destination_messaging_key)throw new Error("Snapshot differs from the retained account/Offer");
}
export async function exportTransferSnapshot(client:AccountApiClient,path:string,output:string) {
  const account=await client.account(),state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768))) as State;
  if(state.type!=="hailp.account-transfer"||state.version!==1||state.provider!==account.provider||state.accountId!==account.accountId||state.did!==account.did||state.key!==account.identityPublicKey||
    account.custodyProfile!=="owner-controlled"||!account.scopes.includes("account:write")||!["fenced","exported"].includes(account.migrationState as string))throw new Error("Snapshot export requires the original fenced owner-controlled source account");
  const {offer}=await retainedSelection(state),snapshot=await client.request("/transfers/export",{transferId:offer.transfer_id},"/api/v1/account",100000000);
  snapshotMatches((await verifyTransferSnapshot(snapshot)).manifest,state,offer);
  let existing:Record<string,unknown>|undefined;
  try {existing=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(output,100000000)));}
  catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  if(existing){if(existing.type!==snapshot.type||existing.version!==snapshot.version||["manifest","digest","signature","sourceMessagingPublicKey"].some(key=>existing![key]!==snapshot[key]))throw new Error("Retained snapshot output changed");}
  else await savePrivateBytes(output,new TextEncoder().encode(JSON.stringify(snapshot)));
  return {did:state.did,transferId:offer.transfer_id,digest:snapshot.digest,state:"exported",snapshotFile:output};
}
export async function signAccountTransferCutover(vaultPath:string,path:string,snapshotPath:string,consentPath:string,operationPath:string,bindingPath:string,recoveryInput=readRecoverySecret) {
  const state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768))) as State;
  if(state.type!=="hailp.account-transfer"||state.version!==1)throw new Error("Cutover requires the original transfer state");
  const {offer}=await retainedSelection(state),snapshot=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(snapshotPath,100000000)));
  snapshotMatches((await verifyTransferSnapshot(snapshot)).manifest,state,offer);
  const cutover={snapshotDigest:snapshot.digest as string,consentPath,operationPath,bindingPath};
  if(state.cutover&&Object.entries(cutover).some(([key,value])=>state.cutover![key as keyof typeof cutover]!==value))throw new Error("Cutover snapshot/output paths changed; retain the exact original artifacts");
  if(state.cutover?.operationCid){
    try {await Promise.all([privateFile(operationPath,16000),privateFile(consentPath,16384),privateFile(bindingPath,16384)]);}
    catch{throw new Error("Completed cutover artifacts are missing or invalid; restore the originals instead of signing replacements");}
  }
  state.cutover={...state.cutover,...cutover};await writeState(path,state);
  const result=await signPrivatePocCutover(vaultPath,snapshotPath,{...state.offer!},{...state.reservation!},consentPath,operationPath,bindingPath,recoveryInput);
  if(state.cutover.operationCid&&state.cutover.operationCid!==result.operationCid)throw new Error("Retained cutover operation CID changed");
  state.cutover.operationCid=result.operationCid;await writeState(path,state);return result;
}

export async function completeAccountTransfer(path:string,snapshotPath:string,transport:typeof fetch=fetch) {
  const state=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(path,32768))) as State;
  if(state.type!=="hailp.account-transfer"||state.version!==1||!state.cutover?.operationCid)throw new Error("Completion requires the original completed cutover-signing state");
  const {offer,reservation}=await retainedSelection(state),snapshot=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(snapshotPath,100000000)));
  const verified=await verifyTransferSnapshot(snapshot);snapshotMatches(verified.manifest,state,offer);
  if(snapshot.digest!==state.cutover.snapshotDigest)throw new Error("Completion snapshot changed");
  const operationBytes=await privateFile(state.cutover.operationPath,16000),binding=await privateFile(state.cutover.bindingPath,16384);
  const operation=def.operation.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(operationBytes))),operationCid=(await cidForCbor(operation)).toString();
  if(operationCid!==state.cutover.operationCid)throw new Error("Completion operation differs from the retained exact CID");
  const container=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(state.cutover.consentPath,16384)));
  if(container.type!=="hail.portable-migration-consent"||container.version!==1)throw new Error("Invalid retained migration consent");
  const consent=record({payload:container.payload,signature:container.signature}),consentBytes=decodeBase64Url(consent.payload);
  await verifySignature("hail.portable-migration-consent.v1",consentBytes,decodeBase64Url(consent.signature),state.key);
  const value=decodeDeterministic(consentBytes) as Record<string,any>,custody=(verified.manifest.tables as Record<string,any>).portable_custody_evidence[0];
  if(value.type!=="hail.portable-migration-consent"||value.version!==1||value.did!==state.did||value.transfer_id!==offer.transfer_id||
    value.source_service_base!==`${state.provider}/hail`||value.destination_service_base!==`${state.destination}/hail`||value.destination_address!==reservation.address||
    value.destination_rotation_key!==offer.destination_rotation_key||value.destination_messaging_key!==offer.destination_messaging_key||
    value.user_identity_key!==state.key||value.user_recovery_key!==custody.user_recovery_public_key||!digest(value.snapshot_digest)||!digest(value.plc_operation_sha256)||
    !equal(value.snapshot_digest,verified.digest)||!equal(value.plc_operation_sha256,sha(new Uint8Array(dagCbor.encode(operation))))||
    !Number.isSafeInteger(value.created_at)||!Number.isSafeInteger(value.expires_at)||value.expires_at<=value.created_at||value.expires_at-value.created_at>604800||
    !equal(consentBytes,encodeDeterministic(value)))throw new Error("Completion consent differs from the retained cutover");
  const response=await targetRequest(state.destination,"completions",{snapshot,consent,operation:encodeBase64Url(operationBytes),binding:encodeBase64Url(binding)},transport);
  const result=response.record as Record<string,unknown>;
  if(!result||result.type!=="hailp.transfer-completion"||result.version!==1||result.did!==state.did||result.accountId!==state.accountId||result.transferId!==offer.transfer_id||
    result.operationCid!==operationCid||result.phase!=="active")throw new Error("Destination did not confirm the retained exact transfer");
  const receipt=record(result.receipt),receiptBytes=decodeBase64Url(receipt.payload);
  await verifySignature("hail.portable-migration-activated.v1",receiptBytes,decodeBase64Url(receipt.signature),offer.destination_messaging_key);
  const activated=decodeDeterministic(receiptBytes) as Record<string,any>;
  if(activated.type!=="hail.portable-migration-activated"||activated.version!==1||Object.keys(activated).length!==10||activated.did!==state.did||activated.transfer_id!==offer.transfer_id||
    activated.destination_service_base!==`${state.destination}/hail`||activated.destination_messaging_key!==offer.destination_messaging_key||activated.destination_address!==reservation.address||
    !digest(activated.snapshot_digest)||!equal(activated.snapshot_digest,verified.digest)||!digest(activated.address_binding_digest)||!equal(activated.address_binding_digest,sha(binding))||
    !Number.isSafeInteger(activated.activated_at)||activated.activated_at>Math.floor(Date.now()/1000)+300||!equal(receiptBytes,encodeDeterministic(activated)))throw new Error("Activation receipt differs from the exact snapshot/address/binding");
  if(state.activationReceipt&&(state.activationReceipt.payload!==receipt.payload||state.activationReceipt.signature!==receipt.signature))throw new Error("Destination activation receipt changed");
  state.activationReceipt=receipt;await writeState(path,state);
  try {await targetRequest(state.provider,"retirements",receipt,transport);}
  catch(error){throw new Error(`Destination active; source retirement is unconfirmed: ${error instanceof Error?error.message:"transport failed"}. Retry the exact transfer state`);}
  state.retired=true;await writeState(path,state);
  return {did:state.did,transferId:offer.transfer_id,destination:state.destination,address:reservation.address,operationCid,destinationActive:true,sourceRetired:true,
    credentials:"destination owner login required",stateFile:path};
}
