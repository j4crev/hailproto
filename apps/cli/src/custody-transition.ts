import { decodeBase64Url, decodeDeterministic, encodeBase64Url, type HailAddressBinding, type HailGrant } from "@hailproto/codec";
import { def } from "@did-plc/lib";
import { AccountApiClient } from "./account-api.js";
import { writeState } from "./account-creation.js";
import { privateFile } from "./grant-revocation.js";
import { replaceUserIdentity, unlockUserVault, type ManagedCustodyTransitionApproval,
  type ManagedCustodyTransitionPreparation, type UserVaultFile } from "./vault.js";
import { readRecoverySecret } from "./cli/private-input.js";

interface State {type:"hailp.custody-transition-state";version:1;provider:string;accountId:string;did:string;transitionId:string;
  direction?:"owner-to-managed"|"managed-to-owner";operation:string;operationCid:string;approval:string;signature:string;
  binding:string;bindingDigest:string;newIdentityKey:string;generationTo?:number;}
type RetainedState=State&{generationTo:number};
interface OwnerKeyState {type:"hailp.custody-transition-key";version:1;provider:string;accountId:string;did:string;
  direction:"managed-to-owner";newIdentityKey:string;}
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const didKey=(value:unknown):value is string=>typeof value==="string"&&/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value);

function retained(value:unknown,provider:string,accountId:string,did:string,direction:"owner-to-managed"|"managed-to-owner"):RetainedState {
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid custody transition state");
  const state=value as State;
  if(state.type!=="hailp.custody-transition-state"||state.version!==1||state.provider!==provider||state.accountId!==accountId||
    state.did!==did||(state.direction??"owner-to-managed")!==direction||!uuid(state.transitionId)||typeof state.operation!=="string"||typeof state.operationCid!=="string"||
    typeof state.approval!=="string"||typeof state.signature!=="string"||typeof state.binding!=="string"||
    typeof state.bindingDigest!=="string"||!didKey(state.newIdentityKey)||decodeBase64Url(state.signature).length!==64)
    throw new Error("Retained custody transition state differs from the selected account");
  let generationTo=state.generationTo;
  if(generationTo===undefined) {
    const approval=decodeDeterministic(decodeBase64Url(state.approval)) as unknown as ManagedCustodyTransitionApproval;
    if(approval.type!=="hailp.custody-transition"||approval.version!==1||approval.transition_id!==state.transitionId||
      approval.did!==state.did||approval.direction!==direction)throw new Error("Retained custody approval differs from its state");
    generationTo=approval.generation_to;
  }
  if(!Number.isSafeInteger(generationTo)||generationTo<1)throw new Error("Retained custody transition has an invalid generation");
  return {...state,generationTo};
}

export async function transitionToManaged(client:AccountApiClient,vaultPath:string|undefined,statePath:string,
  recoveryInput=readRecoverySecret) {
  const account=await client.account();
  if(!account.scopes.includes("account:write"))throw new Error("Custody transition requires account:write authority");
  let state:RetainedState|undefined;
  try{state=retained(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(statePath,131072))),
    account.provider,account.accountId,account.did,"owner-to-managed");}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  if(!state) {
    if(account.custodyProfile!=="owner-controlled"||typeof account.identityPublicKey!=="string"||typeof account.ownerRecoveryPublicKey!=="string")
      throw new Error("A current owner-controlled account is required");
    if(!vaultPath)throw new Error("First custody preparation requires --vault; exact retries use the retained --state file");
    const raw=await client.request("/custody/managed",{});
    if(!uuid(raw.transitionId)||raw.accountId!==account.accountId||raw.did!==account.did||raw.direction!=="owner-to-managed"||
      raw.ownerRecoveryKey!==account.ownerRecoveryPublicKey||raw.oldIdentityKey!==account.identityPublicKey||!didKey(raw.newIdentityKey)||
      typeof raw.previousOperationCid!=="string"||typeof raw.historyCheckpointDigest!=="string"||typeof raw.bindingCose!=="string"||
      typeof raw.bindingDigest!=="string"||!Number.isSafeInteger(raw.generationFrom)||raw.generationTo!==(raw.generationFrom as number)+1||
      typeof raw.expiresAt!=="string"||!raw.currentState||typeof raw.currentState!=="object"||
      !raw.unsignedOperation||typeof raw.unsignedOperation!=="object")throw new Error("Provider returned an invalid custody preparation");
    const preparation:ManagedCustodyTransitionPreparation={transitionId:raw.transitionId,accountId:account.accountId,did:account.did,
      direction:"owner-to-managed",ownerRecoveryKey:raw.ownerRecoveryKey,oldIdentityKey:raw.oldIdentityKey,newIdentityKey:raw.newIdentityKey,
      providerServiceBase:`${account.provider}/hail`,currentState:def.documentData.parse(raw.currentState),
      unsignedOperation:def.unsignedOperation.parse(raw.unsignedOperation),
      previousOperationCid:raw.previousOperationCid,historyCheckpointDigest:decodeBase64Url(raw.historyCheckpointDigest),
      bindingDigest:decodeBase64Url(raw.bindingDigest),generationFrom:raw.generationFrom as number,generationTo:raw.generationTo as number,
      expiresAt:raw.expiresAt};
    const secret=decodeBase64Url(await recoveryInput());
    try {const signer=await unlockUserVault(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(vaultPath,16384))) as UserVaultFile,secret);
      const signed=await signer.signManagedCustodyTransition(preparation);
      state={type:"hailp.custody-transition-state",version:1,provider:account.provider,accountId:account.accountId,did:account.did,
         direction:"owner-to-managed",transitionId:preparation.transitionId,operation:encodeBase64Url(signed.operationBytes),operationCid:signed.operationCid,
         approval:encodeBase64Url(signed.approvalBytes),signature:encodeBase64Url(signed.approvalSignature),binding:raw.bindingCose,
         bindingDigest:raw.bindingDigest,newIdentityKey:preparation.newIdentityKey,generationTo:preparation.generationTo};await writeState(statePath,state);
    } finally {secret.fill(0);}
  }
  const result=await client.request("/custody/managed/commit",{transitionId:state.transitionId,operation:state.operation,
    approval:state.approval,signature:state.signature});
  if(result.transitionId!==state.transitionId||result.did!==state.did||result.state!=="complete"||result.generation!==state.generationTo)
    throw new Error("Provider completion does not match the retained custody transition");
  return {did:state.did,custodyProfile:"managed",identityPublicKey:state.newIdentityKey,generation:result.generation,
    stateFile:statePath,instruction:"Old credentials are terminal; use owner-recovery login for fresh access."};
}

export async function transitionToOwner(client:AccountApiClient,vaultPath:string,statePath:string,recoveryInput=readRecoverySecret) {
  const account=await client.account();
  if(!account.scopes.includes("account:write"))throw new Error("Custody transition requires account:write authority");
  let state:RetainedState|undefined,keyReady:OwnerKeyState|undefined;
  try{const raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(statePath,524288)));
    if(raw?.type==="hailp.custody-transition-key"&&raw.version===1&&raw.provider===account.provider&&raw.accountId===account.accountId&&
      raw.did===account.did&&raw.direction==="managed-to-owner"&&didKey(raw.newIdentityKey))keyReady=raw;
    else state=retained(raw,account.provider,account.accountId,account.did,"managed-to-owner");
  }catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="ENOENT"))throw error;}
  if(!state) {
    if(account.custodyProfile!=="managed"||typeof account.identityPublicKey!=="string"||typeof account.ownerRecoveryPublicKey!=="string")
      throw new Error("A current managed account is required");
    const secret=decodeBase64Url(await recoveryInput());
    try {
      const stored=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await privateFile(vaultPath,16384))) as UserVaultFile;
      const owner=keyReady?await unlockUserVault(stored,secret):await replaceUserIdentity(stored,secret);
      if(keyReady&&owner.vault.identity.publicDidKey!==keyReady.newIdentityKey)throw new Error("Retained owner transition key differs from the vault");
      if(!keyReady) {await writeState(vaultPath,owner.vault);keyReady={type:"hailp.custody-transition-key",version:1,provider:account.provider,
        accountId:account.accountId,did:account.did,direction:"managed-to-owner",newIdentityKey:owner.vault.identity.publicDidKey};await writeState(statePath,keyReady);}
      const review=await client.request("/custody/owner-controlled/review",{newIdentityKey:owner.vault.identity.publicDidKey});
      if(review.direction!=="managed-to-owner"||review.accountId!==account.accountId||review.did!==account.did||
        review.ownerRecoveryKey!==owner.vault.recovery.publicDidKey||review.oldIdentityKey!==account.identityPublicKey||
        review.newIdentityKey!==owner.vault.identity.publicDidKey||typeof review.binding!=="string"||!Array.isArray(review.activeGrants)||
        !review.unsignedOperation||typeof review.unsignedOperation!=="object")throw new Error("Provider returned an invalid owner-custody review");
      const binding=decodeDeterministic(decodeBase64Url(review.binding)) as unknown as HailAddressBinding;
      if(binding.type!=="hail.address-binding"||binding.version!==1||binding.address!==account.address||binding.did!==account.did||
        binding.key_id!==`${account.did}#hail-identity`)throw new Error("Provider returned a binding outside the selected account transition");
      const bindingCose=await owner.signAddressBinding(binding),grants:{grantId:string;cose:string}[]=[];
      for(const raw of review.activeGrants as Record<string,unknown>[]) {
        if(!raw||typeof raw.grantId!=="string"||typeof raw.payload!=="string"||typeof raw.predecessorDigest!=="string"||
          typeof raw.destinationServiceBase!=="string")throw new Error("Provider returned an invalid Grant review");
        const payload=decodeDeterministic(decodeBase64Url(raw.payload)) as unknown as HailGrant;
        const predecessor=decodeBase64Url(raw.predecessorDigest);
        if(payload.grant_id!==raw.grantId||payload.grantor!==account.did||payload.key_id!==`${account.did}#hail-identity`||
          payload.status!=="active"||payload.revision<2||!payload.previous||payload.previous.length!==predecessor.length||
          payload.previous.some((byte,index)=>byte!==predecessor[index]))throw new Error("Provider returned a Grant outside the selected account transition");
        grants.push({grantId:raw.grantId,cose:encodeBase64Url(await owner.signGrant(payload))});
      }
      const raw=await client.request("/custody/owner-controlled",{newIdentityKey:owner.vault.identity.publicDidKey,
        binding:encodeBase64Url(bindingCose),grants});
      if(!uuid(raw.transitionId)||raw.accountId!==account.accountId||raw.did!==account.did||raw.direction!=="managed-to-owner"||
        raw.ownerRecoveryKey!==owner.vault.recovery.publicDidKey||raw.oldIdentityKey!==account.identityPublicKey||
        raw.newIdentityKey!==owner.vault.identity.publicDidKey||typeof raw.previousOperationCid!=="string"||
        typeof raw.historyCheckpointDigest!=="string"||typeof raw.bindingDigest!=="string"||!Number.isSafeInteger(raw.generationFrom)||
        raw.generationTo!==(raw.generationFrom as number)+1||typeof raw.expiresAt!=="string"||!raw.currentState||typeof raw.currentState!=="object"||
        !raw.unsignedOperation||typeof raw.unsignedOperation!=="object")
        throw new Error("Provider returned an invalid owner-custody preparation");
      const preparation:ManagedCustodyTransitionPreparation={transitionId:raw.transitionId,accountId:account.accountId,did:account.did,
        direction:"managed-to-owner",ownerRecoveryKey:raw.ownerRecoveryKey,oldIdentityKey:raw.oldIdentityKey,newIdentityKey:raw.newIdentityKey,
        providerServiceBase:`${account.provider}/hail`,currentState:def.documentData.parse(raw.currentState),
        unsignedOperation:def.unsignedOperation.parse(raw.unsignedOperation),
        previousOperationCid:raw.previousOperationCid,historyCheckpointDigest:decodeBase64Url(raw.historyCheckpointDigest),
        bindingDigest:decodeBase64Url(raw.bindingDigest),generationFrom:raw.generationFrom as number,generationTo:raw.generationTo as number,
        expiresAt:raw.expiresAt};
      const signed=await owner.signManagedCustodyTransition(preparation);
      state={type:"hailp.custody-transition-state",version:1,provider:account.provider,accountId:account.accountId,did:account.did,
         direction:"managed-to-owner",transitionId:preparation.transitionId,operation:encodeBase64Url(signed.operationBytes),operationCid:signed.operationCid,
         approval:encodeBase64Url(signed.approvalBytes),signature:encodeBase64Url(signed.approvalSignature),binding:encodeBase64Url(bindingCose),
         bindingDigest:raw.bindingDigest,newIdentityKey:preparation.newIdentityKey,generationTo:preparation.generationTo};await writeState(statePath,state);
    } finally {secret.fill(0);}
  }
  const result=await client.request("/custody/managed/commit",{transitionId:state.transitionId,operation:state.operation,
    approval:state.approval,signature:state.signature});
  if(result.transitionId!==state.transitionId||result.did!==state.did||result.state!=="complete"||result.generation!==state.generationTo)
    throw new Error("Provider completion does not match the retained custody transition");
  return {did:state.did,custodyProfile:"owner-controlled",identityPublicKey:state.newIdentityKey,generation:result.generation,
    vaultFile:vaultPath,stateFile:statePath,instruction:"Old credentials are terminal; use identity login with the updated vault for fresh access."};
}
