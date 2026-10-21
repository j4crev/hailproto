import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { cidForCbor } from "@atproto/common";
import { assureValidSig, def, validateOperationLog, type DocumentData, type Operation, type UnsignedOperation } from "@did-plc/lib";
import { verifySignature } from "@atproto/crypto";
import { createWebCryptoSigner, createWebCryptoVerifier, decodeDeterministic, encodeBase64Url, encodeDeterministic, inspectSignedPayload,
  signPayload, verifySignedPayload, type HailAddressBinding, type HailGrant, type HailValue } from "@hailproto/codec";
import * as dagCbor from "@ipld/dag-cbor";
import type { SQL } from "bun";
import { materializedServingGeneration } from "../db/serving.js";
import type { KeyEncryptor } from "../identity/key-encryption.js";
import { generateAccountIdentityKey } from "../identity/keys.js";
import { MANAGED_CUSTODY_PROFILE_VERSION } from "../identity/managed-profile.js";
import { parseJsonWithoutDuplicateKeys } from "../discovery/strict-json.js";
import type { AddressVerificationService } from "../onboarding/activation.js";
import type { PlcDirectoryClient } from "../plc/client.js";
import { retainPublicGrantAuthority } from "../plc/grant-authority.js";
import type { HailDidResolver, PlcResolutionEvidence } from "../plc/resolver.js";
import { retainPublicSigningAuthority } from "../plc/signing-authority.js";
import { ed25519PublicKeyFromDidKey } from "../identity/did-key.js";

const sha256 = (value: Uint8Array) => new Uint8Array(createHash("sha256").update(value).digest());
const equal = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const jsonEvidence = (value: unknown) => JSON.stringify(value);

export interface CustodyTransitionApproval {
  type: "hailp.custody-transition";
  version: 1;
  transition_id: string;
  did: string;
  direction: "owner-to-managed"|"managed-to-owner";
  provider_service_base: string;
  owner_recovery_key: string;
  old_identity_key: string;
  new_identity_key: string;
  previous_operation_cid: string;
  operation_cid: string;
  history_checkpoint_sha256: Uint8Array;
  binding_sha256: Uint8Array;
  generation_from: number;
  generation_to: number;
  nonce: string;
  issued_at: number;
  expires_at: number;
}

interface TransitionRow {
  transition_id: string; account_id: string; did: string; direction:"owner-to-managed"|"managed-to-owner"; state: "prepared"|"submission-unknown"|"complete";
  owner_recovery_public_key: string; old_identity_public_key: string; new_identity_public_key: string;
  previous_operation_cid: string; expected_state: DocumentData|string; history_checkpoint_digest: Uint8Array;
  binding_cose: Uint8Array; binding_digest: Uint8Array; encrypted_identity_private_key: Uint8Array|null;
  identity_encryption_nonce: Uint8Array|null; identity_encryption_version: number|null; identity_kek_id: string|null;
  signed_operation_bytes: Uint8Array|null; operation_cid: string|null; approval_payload: Uint8Array|null;
  approval_signature: Uint8Array|null; generation_from: number|string|bigint; generation_to: number|string|bigint;
  expires_at: Date;
}
interface GrantRow {
  grant_id:string; current_revision:number; current_digest:Uint8Array; current_status:"active"|"revoked";
  cose:Uint8Array; representation_digest:Uint8Array; signing_public_key:string;
  publication_state:string|null; destination_service_base:string|null; acknowledged_etag:string|null;
}
interface HistoryRow {grant_id:string;revision:number;lineage_current_revision:number;lineage_current_status:string;cose:Uint8Array;
  representation_digest:Uint8Array;signing_public_key:string;publication_state:string|null;acknowledged_etag:string|null;}
interface SuccessorRow { grant_id:string;predecessor_revision:number;predecessor_digest:Uint8Array;
  successor_revision:number;successor_cose:Uint8Array;successor_digest:Uint8Array;destination_service_base:string; }

export interface CustodyTransitionPreparation {
  transitionId:string; accountId:string; did:string; direction:"owner-to-managed"|"managed-to-owner";
  ownerRecoveryKey:string; oldIdentityKey:string; newIdentityKey:string;
  currentState:DocumentData; unsignedOperation:UnsignedOperation; previousOperationCid:string;
  historyCheckpointDigest:Uint8Array; bindingCose:Uint8Array; bindingDigest:Uint8Array;
  generationFrom:number; generationTo:number; expiresAt:string;
}

export interface OwnerCustodyReview {
  accountId:string;did:string;direction:"managed-to-owner";ownerRecoveryKey:string;oldIdentityKey:string;newIdentityKey:string;
  unsignedOperation:UnsignedOperation;previousOperationCid:string;generationFrom:number;generationTo:number;
  binding:HailAddressBinding;activeGrants:{grantId:string;payload:HailGrant;predecessorDigest:Uint8Array;destinationServiceBase:string}[];
}

function approvalInput(payload:Uint8Array) {
  const tag=new TextEncoder().encode("hailp.custody-transition.v1\0");
  const input=new Uint8Array(tag.length+payload.length);input.set(tag);input.set(payload,tag.length);return input;
}
function number(value:number|string|bigint,name:string) {
  const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)throw new Error(`Invalid ${name}`);return parsed;
}
function parsedState(value:DocumentData|string):DocumentData {
  return def.documentData.parse(typeof value==="string"?parseJsonWithoutDuplicateKeys(value):value);
}

export class SameProviderCustodyTransition {
  constructor(private readonly sql:SQL,private readonly plc:PlcDirectoryClient,private readonly resolver:HailDidResolver,
    private readonly encryptor:KeyEncryptor,private readonly serviceBase:string,private readonly verifier:AddressVerificationService,
    private readonly now:()=>Date=()=>new Date()) {}

  async reviewOwner(accountId:string,newIdentityKey:string):Promise<OwnerCustodyReview> {
    await ed25519PublicKeyFromDidKey(newIdentityKey);
    const account=(await this.sql<{did:string;canonical_address:string;onboarding_state:string;activation_verification_mode:string}[]>`
      SELECT did,canonical_address,onboarding_state,activation_verification_mode FROM provider_accounts WHERE id=${accountId}`)[0];
    if(!account||account.onboarding_state!=="active"||account.activation_verification_mode!=="public")throw new Error("A public active account is required");
    const managed=(await this.sql<{owner_recovery_public_key:string;provider_identity_public_key:string}[]>`
      SELECT owner_recovery_public_key,provider_identity_public_key FROM managed_custody_evidence WHERE account_id=${accountId}`)[0];
    if(!managed)throw new Error("Managed custody is required");
    const current=await this.resolver.resolve(account.did);
    const currentState=def.documentData.parse(current.evidence.data);
    if(current.serviceBase!==this.serviceBase||!current.evidence.verification||current.identityDidKey!==managed.provider_identity_public_key||
      currentState.rotationKeys[0]!==managed.owner_recovery_public_key)throw new Error("Strict managed PLC authority is required");
    if([current.identityDidKey,current.messagingDidKey,...currentState.rotationKeys].includes(newIdentityKey))
      throw new Error("Owner custody requires a fresh identity key");
    const log=current.evidence.log.map(value=>def.operation.parse(value));
    if(!log.length||!isDeepStrictEqual(await validateOperationLog(account.did,log),current.evidence.data))throw new Error("Current PLC history is invalid");
    const previousOperationCid=(await cidForCbor(log.at(-1)!)).toString();
    const expectedState=def.documentData.parse({...currentState,verificationMethods:{...currentState.verificationMethods,"hail-identity":newIdentityKey}});
    const generation=number((await this.sql<{generation:number|string|bigint}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId}`)[0]!.generation,"serving generation");
    const now=Math.floor(this.now().getTime()/1000),activeGrants=[] as OwnerCustodyReview["activeGrants"];
    for(const grant of (await this.grants(this.sql,accountId)).filter(row=>row.current_status==="active")) {
      if(grant.publication_state!=="acknowledged"||!grant.destination_service_base||!grant.acknowledged_etag)
        throw new Error("Every active authoritative Grant needs an acknowledged predecessor");
      const payload=inspectSignedPayload("hail.grant",new Uint8Array(grant.cose)).payload;
      activeGrants.push({grantId:grant.grant_id,payload:{...payload,revision:payload.revision+1,previous:Uint8Array.from(grant.current_digest),
        updated_at:Math.max(now,payload.updated_at+1)},predecessorDigest:grant.current_digest,destinationServiceBase:grant.destination_service_base});
    }
    return {accountId,did:account.did,direction:"managed-to-owner",ownerRecoveryKey:managed.owner_recovery_public_key,
      oldIdentityKey:managed.provider_identity_public_key,newIdentityKey,
      unsignedOperation:def.unsignedOperation.parse({type:"plc_operation",prev:previousOperationCid,rotationKeys:expectedState.rotationKeys,
        verificationMethods:expectedState.verificationMethods,alsoKnownAs:expectedState.alsoKnownAs,services:expectedState.services}),
      previousOperationCid,generationFrom:generation,generationTo:generation+1,
      binding:{type:"hail.address-binding",version:1,address:account.canonical_address,did:account.did,issued_at:now,
        expires_at:now+90*86400,key_id:`${account.did}#hail-identity`},activeGrants};
  }

  async prepareOwner(accountId:string,newIdentityKey:string,bindingCose:Uint8Array,
    signedGrants:{grantId:string;cose:Uint8Array}[]):Promise<CustodyTransitionPreparation> {
    const prior=(await this.sql<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE account_id=${accountId} AND state<>'complete'`)[0];
    if(prior)return this.preparation(prior);
    const review=await this.reviewOwner(accountId,newIdentityKey);
    const verifier=createWebCryptoVerifier(async kid=>{if(kid!==`${review.did}#hail-identity`)throw new Error("Owner signer differs");
      return ed25519PublicKeyFromDidKey(newIdentityKey);});
    const binding=(await verifySignedPayload("hail.address-binding",bindingCose,verifier)).payload;
    if(!isDeepStrictEqual(binding,review.binding))throw new Error("Owner binding differs from the reviewed transition");
    if(signedGrants.length!==review.activeGrants.length||new Set(signedGrants.map(value=>value.grantId)).size!==signedGrants.length)
      throw new Error("Owner Grant successor set is incomplete");
    const successors:{row:SuccessorRow;payload:HailGrant}[]=[];
    for(const expected of review.activeGrants) {
      const supplied=signedGrants.find(value=>value.grantId===expected.grantId);if(!supplied)throw new Error("Owner Grant successor is missing");
      const payload=(await verifySignedPayload("hail.grant",supplied.cose,verifier)).payload;
      if(!isDeepStrictEqual(payload,expected.payload))throw new Error("Owner Grant successor differs from the reviewed predecessor");
      successors.push({payload,row:{grant_id:expected.grantId,predecessor_revision:payload.revision-1,
        predecessor_digest:expected.predecessorDigest,successor_revision:payload.revision,successor_cose:supplied.cose,
        successor_digest:sha256(supplied.cose),destination_service_base:expected.destinationServiceBase}});
    }
    const history=await this.history(this.sql,accountId),bindingDigest=sha256(bindingCose);
    const checkpoint=sha256(encodeDeterministic({type:"hailp.custody-history-checkpoint",version:1,did:review.did,
      revisions:history.revisions.map(row=>({grant_id:row.grant_id,revision:row.revision,current_revision:row.lineage_current_revision,
        current_status:row.lineage_current_status,digest:encodeBase64Url(row.representation_digest),cose_sha256:encodeBase64Url(sha256(row.cose)),
        signer:row.signing_public_key,publication:row.publication_state??"none",etag:row.acknowledged_etag??""})),
      bindings:history.bindings.map(row=>({id:row.id,digest:encodeBase64Url(row.representation_digest),cose_sha256:encodeBase64Url(sha256(row.cose)),
        selected:row.selected_at?.toISOString()??"",published:row.published_at?.toISOString()??""})),
      successors:successors.map(({row})=>({grant_id:row.grant_id,revision:row.successor_revision,previous:encodeBase64Url(row.predecessor_digest),
        digest:encodeBase64Url(row.successor_digest)}))} as unknown as HailValue));
    const transitionId=randomUUID(),expiresAt=new Date(this.now().getTime()+3600000),state=def.documentData.parse({did:review.did,
      rotationKeys:review.unsignedOperation.rotationKeys,verificationMethods:review.unsignedOperation.verificationMethods,
      alsoKnownAs:review.unsignedOperation.alsoKnownAs,services:review.unsignedOperation.services});
    return this.sql.begin(async tx=>{await tx`SELECT set_config('hail.custody_transition',${accountId},true)`;
      await tx`SELECT id FROM provider_accounts WHERE id=${accountId} FOR UPDATE`;
      const raced=(await tx<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE account_id=${accountId} AND state<>'complete'`)[0];
      if(raced)return this.preparation(raced);
      const managed=(await tx<{provider_identity_public_key:string}[]>`SELECT provider_identity_public_key FROM managed_custody_evidence WHERE account_id=${accountId}`)[0];
      if(!managed||managed.provider_identity_public_key!==review.oldIdentityKey)throw new Error("Managed custody changed");
      await tx`INSERT INTO custody_transition_preparations (transition_id,account_id,did,direction,state,owner_recovery_public_key,
        old_identity_public_key,new_identity_public_key,previous_operation_cid,expected_state,history_checkpoint_digest,binding_cose,
        binding_digest,generation_from,generation_to,expires_at,managed_profile_version) VALUES (${transitionId},${accountId},${review.did},'managed-to-owner','prepared',
        ${review.ownerRecoveryKey},${review.oldIdentityKey},${newIdentityKey},${review.previousOperationCid},(${JSON.stringify(state)}::text)::jsonb,
        ${checkpoint},${bindingCose},${bindingDigest},${review.generationFrom},${review.generationTo},${expiresAt},${MANAGED_CUSTODY_PROFILE_VERSION})`;
      for(const {row} of successors)await tx`INSERT INTO custody_transition_grant_successors
        (transition_id,grant_id,predecessor_revision,predecessor_digest,successor_revision,successor_cose,successor_digest,destination_service_base)
        VALUES (${transitionId},${row.grant_id},${row.predecessor_revision},${row.predecessor_digest},${row.successor_revision},${row.successor_cose},
          ${row.successor_digest},${row.destination_service_base})`;
      return this.preparation((await tx<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE transition_id=${transitionId}`)[0]!);});
  }

  async prepare(accountId:string):Promise<CustodyTransitionPreparation> {
    const prior=(await this.sql<TransitionRow[]>`SELECT * FROM custody_transition_preparations
      WHERE account_id=${accountId} AND state<>'complete'`)[0];
    if(prior)return this.preparation(prior);
    const account=(await this.sql<{did:string;canonical_address:string;onboarding_state:string;activation_verification_mode:string}[]>`
      SELECT did,canonical_address,onboarding_state,activation_verification_mode FROM provider_accounts WHERE id=${accountId}`)[0];
    if(!account||account.onboarding_state!=="active"||account.activation_verification_mode!=="public")throw new Error("A public active account is required");
    const current=await this.resolver.resolve(account.did);
    if(current.serviceBase!==this.serviceBase||!current.evidence.verification)throw new Error("Strict current PLC authority is required");
    const log=current.evidence.log.map(value=>def.operation.parse(value));
    if(!log.length||!isDeepStrictEqual(await validateOperationLog(account.did,log),current.evidence.data))throw new Error("Current PLC history is invalid");
    const previousOperationCid=(await cidForCbor(log.at(-1)!)).toString();
    const generated=await generateAccountIdentityKey(accountId,this.encryptor);
    if(generated.didKey===current.identityDidKey||generated.didKey===current.messagingDidKey)throw new Error("Fresh managed identity generation failed");
    const expectedState=def.documentData.parse({...current.evidence.data,verificationMethods:{
      ...(current.evidence.data as DocumentData).verificationMethods,"hail-identity":generated.didKey}});
    const unsignedOperation=def.unsignedOperation.parse({type:"plc_operation",prev:previousOperationCid,
      rotationKeys:expectedState.rotationKeys,verificationMethods:expectedState.verificationMethods,
      alsoKnownAs:expectedState.alsoKnownAs,services:expectedState.services});
    const now=Math.floor(this.now().getTime()/1000),binding:HailAddressBinding={type:"hail.address-binding",version:1,
      address:account.canonical_address,did:account.did,issued_at:now,expires_at:now+90*86400,key_id:`${account.did}#hail-identity`};
    const bindingCose=await signPayload("hail.address-binding",binding,createWebCryptoSigner(binding.key_id,generated.privateKey));
    const bindingDigest=sha256(bindingCose),transitionId=randomUUID(),expiresAt=new Date(this.now().getTime()+60*60*1000);
    return this.sql.begin(async tx=>{
      await tx`SELECT set_config('hail.custody_transition',${accountId},true)`;
      const locked=(await tx<{did:string}[]>`SELECT did FROM provider_accounts WHERE id=${accountId} FOR UPDATE`)[0];
      const raced=(await tx<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE account_id=${accountId} AND state<>'complete'`)[0];
      if(raced)return this.preparation(raced);
      if(!locked||locked.did!==account.did||(await tx`SELECT account_id FROM managed_custody_evidence WHERE account_id=${accountId}`).length)throw new Error("Account custody changed");
      const portable=(await tx<{user_recovery_public_key:string;user_identity_public_key:string}[]>`
        SELECT user_recovery_public_key,user_identity_public_key FROM portable_custody_evidence WHERE account_id=${accountId}`)[0];
      if(!portable||portable.user_identity_public_key!==current.identityDidKey||expectedState.rotationKeys[0]!==portable.user_recovery_public_key)
        throw new Error("Portable custody evidence does not match current PLC authority");
      const keys=await tx<{role:string;public_key:string}[]>`SELECT role,public_key FROM account_keys WHERE account_id=${accountId}`;
      if(keys.some(k=>k.role==="hail-identity")||!keys.some(k=>k.role==="hail-messaging"&&k.public_key===current.messagingDidKey)||
        !keys.some(k=>k.role==="plc-rotation"&&expectedState.rotationKeys.slice(1).includes(k.public_key)))throw new Error("Provider operational keys do not match current PLC authority");
      const generation=number((await tx<{generation:number|string|bigint}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${accountId} FOR UPDATE`)[0]!.generation,"serving generation");
      const grants=await this.grants(tx,accountId),history=await this.history(tx,accountId);
      const successors:{row:SuccessorRow;payload:HailGrant}[]=[];
      for(const grant of grants.filter(row=>row.current_status==="active")) {
        if(grant.publication_state!=="acknowledged"||!grant.destination_service_base||!grant.acknowledged_etag)
          throw new Error("Every active authoritative Grant needs an acknowledged predecessor");
        const payload=inspectSignedPayload("hail.grant",new Uint8Array(grant.cose)).payload;
        const updated=Math.max(now,payload.updated_at+1);if(updated>now+300)throw new Error("Grant successor timestamp is too far ahead");
        const successor:HailGrant={...payload,revision:payload.revision+1,previous:Uint8Array.from(grant.current_digest),updated_at:updated};
        const cose=await signPayload("hail.grant",successor,createWebCryptoSigner(`${account.did}#hail-identity`,generated.privateKey));
        successors.push({payload:successor,row:{grant_id:grant.grant_id,predecessor_revision:grant.current_revision,
          predecessor_digest:grant.current_digest,successor_revision:successor.revision,successor_cose:cose,
          successor_digest:sha256(cose),destination_service_base:grant.destination_service_base}});
      }
      const checkpoint=sha256(encodeDeterministic({type:"hailp.custody-history-checkpoint",version:1,did:account.did,
        revisions:history.revisions.map(row=>({grant_id:row.grant_id,revision:row.revision,current_revision:row.lineage_current_revision,
          current_status:row.lineage_current_status,digest:encodeBase64Url(row.representation_digest),
          cose_sha256:encodeBase64Url(sha256(row.cose)),signer:row.signing_public_key,
          publication:row.publication_state??"none",etag:row.acknowledged_etag??""})),
        bindings:history.bindings.map(row=>({id:row.id,digest:encodeBase64Url(row.representation_digest),
          cose_sha256:encodeBase64Url(sha256(row.cose)),selected:row.selected_at?.toISOString()??"",
          published:row.published_at?.toISOString()??""})),
        successors:successors.map(({row})=>({grant_id:row.grant_id,revision:row.successor_revision,
          previous:encodeBase64Url(row.predecessor_digest),digest:encodeBase64Url(row.successor_digest)}))} as unknown as HailValue));
      await tx`INSERT INTO custody_transition_preparations (transition_id,account_id,did,direction,state,
        owner_recovery_public_key,old_identity_public_key,new_identity_public_key,previous_operation_cid,expected_state,
        history_checkpoint_digest,binding_cose,binding_digest,encrypted_identity_private_key,identity_encryption_nonce,
        identity_encryption_version,identity_kek_id,generation_from,generation_to,expires_at,managed_profile_version)
        VALUES (${transitionId},${accountId},${account.did},'owner-to-managed','prepared',${portable.user_recovery_public_key},
          ${portable.user_identity_public_key},${generated.didKey},${previousOperationCid},(${JSON.stringify(expectedState)}::text)::jsonb,
          ${checkpoint},${bindingCose},${bindingDigest},${generated.key.ciphertext},${generated.key.nonce},
          ${generated.key.encryptionVersion},${generated.key.kekId},${generation},${generation+1},${expiresAt},${MANAGED_CUSTODY_PROFILE_VERSION})`;
      for(const {row} of successors)await tx`INSERT INTO custody_transition_grant_successors
        (transition_id,grant_id,predecessor_revision,predecessor_digest,successor_revision,successor_cose,successor_digest,destination_service_base)
        VALUES (${transitionId},${row.grant_id},${row.predecessor_revision},${row.predecessor_digest},${row.successor_revision},
          ${row.successor_cose},${row.successor_digest},${row.destination_service_base})`;
      return {transitionId,accountId,did:account.did,direction:"owner-to-managed",ownerRecoveryKey:portable.user_recovery_public_key,
        oldIdentityKey:portable.user_identity_public_key,newIdentityKey:generated.didKey,unsignedOperation,previousOperationCid,
        currentState:def.documentData.parse(current.evidence.data),
        historyCheckpointDigest:checkpoint,bindingCose,bindingDigest,generationFrom:generation,generationTo:generation+1,
        expiresAt:expiresAt.toISOString()};
    });
  }

  async commit(accountId:string,transitionId:string,operationBytes:Uint8Array,approvalBytes:Uint8Array,approvalSignature:Uint8Array) {
    if(operationBytes.length<1||operationBytes.length>16_000||approvalBytes.length<1||approvalBytes.length>16_384||approvalSignature.length!==64)
      throw new Error("Custody transition evidence exceeds its limit");
    let row=await this.row(accountId,transitionId),operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(operationBytes)));
    const expected=parsedState(row.expected_state),unsigned={type:operation.type,prev:operation.prev,rotationKeys:operation.rotationKeys,
      verificationMethods:operation.verificationMethods,alsoKnownAs:operation.alsoKnownAs,services:operation.services};
    if(!isDeepStrictEqual(unsigned,{type:"plc_operation",prev:row.previous_operation_cid,rotationKeys:expected.rotationKeys,
      verificationMethods:expected.verificationMethods,alsoKnownAs:expected.alsoKnownAs,services:expected.services}))
      throw new Error("Signed PLC operation differs from the prepared full state");
    await assureValidSig([row.owner_recovery_public_key],operation);
    const cid=(await cidForCbor(operation)).toString(),dagBytes=new Uint8Array(dagCbor.encode(operation));
    const approval=decodeDeterministic(approvalBytes) as unknown as CustodyTransitionApproval;
    this.reviewApproval(row,approval,cid,Boolean(row.signed_operation_bytes));
    if(!await verifySignature(row.owner_recovery_public_key,approvalInput(approvalBytes),approvalSignature,{jwtAlg:"ES256"}))
      throw new Error("Invalid owner custody-transition approval");
    await this.sql.begin(async tx=>{
      await tx`SELECT set_config('hail.custody_transition',${row.account_id},true)`;
      const current=(await tx<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE transition_id=${transitionId} FOR UPDATE`)[0];
      if(!current)throw new Error("Custody transition does not exist");
      if(current.signed_operation_bytes) {
        if(!equal(current.signed_operation_bytes,operationBytes)||current.operation_cid!==cid||!equal(current.approval_payload!,approvalBytes)||
          !equal(current.approval_signature!,approvalSignature))throw new Error("Custody transition retry changed exact owner-approved bytes");
      } else {
        if(current.state!=="prepared"||current.expires_at<=this.now())throw new Error("Custody transition preparation expired");
        await tx`UPDATE custody_transition_preparations SET state='submission-unknown',signed_operation=(${JSON.stringify(operation)}::text)::jsonb,
          signed_operation_bytes=${operationBytes},operation_dag_cbor=${dagBytes},operation_cid=${cid},approval_payload=${approvalBytes},
          approval_signature=${approvalSignature} WHERE transition_id=${transitionId}`;
      }
    });
    if(row.state!=="complete") {
      const before=await this.plc.getOperationLog(row.did),last=before.at(-1);
      const lastCid=last?(await cidForCbor(last)).toString():null;
      if(lastCid!==cid) {
        if(lastCid!==row.previous_operation_cid)throw new Error("PLC history advanced beyond the approved predecessor");
        try{await this.plc.sendOperation(row.did,operation as Operation);}catch(error){
          const retry=await this.plc.getOperationLog(row.did),observed=retry.at(-1);
          if(!observed||(await cidForCbor(observed)).toString()!==cid)throw new Error("PLC custody update is ambiguous; retry the exact artifacts",{cause:error});
        }
      }
    }
    const observed=await this.resolver.resolve(row.did);
    if(!observed.evidence.verification||observed.evidence.verification.operationCid!==cid||observed.identityDidKey!==row.new_identity_public_key||
      observed.serviceBase!==this.serviceBase||!isDeepStrictEqual(observed.evidence.data,expected))throw new Error("Validated public reader does not confirm the approved custody state");
    await this.materialize(row,operation,operationBytes,dagBytes,cid,observed.evidence);
    row=await this.row(accountId,transitionId);
    const published=await this.verifier.verify((await this.sql<{canonical_address:string}[]>`SELECT canonical_address FROM provider_accounts WHERE id=${row.account_id}`)[0]!.canonical_address);
    if(published.did!==row.did||published.identityDidKey!==row.new_identity_public_key||published.serviceBase!==this.serviceBase||
      !equal(published.representation,row.binding_cose)||!equal(published.digest,row.binding_digest))throw new Error("Published binding does not match the committed custody transition");
    return {transitionId,did:row.did,state:"complete" as const,generation:number(row.generation_to,"generation")};
  }

  private async materialize(row:TransitionRow,operation:Operation,operationBytes:Uint8Array,dagBytes:Uint8Array,cid:string,evidence:PlcResolutionEvidence) {
    await this.sql.begin(async tx=>{
      await tx`SELECT set_config('hail.custody_transition',${row.account_id},true)`;
      const current=(await tx<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE transition_id=${row.transition_id} FOR UPDATE`)[0];
      if(!current)throw new Error("Custody transition disappeared");if(current.state==="complete")return;
      const account=(await tx<{canonical_address:string;did:string}[]>`SELECT canonical_address,did FROM provider_accounts WHERE id=${row.account_id} FOR UPDATE`)[0];
      const portable=(await tx<{value:Record<string,unknown>}[]>`SELECT to_jsonb(p) AS value FROM portable_custody_evidence p WHERE account_id=${row.account_id} FOR UPDATE`)[0];
      const managed=(await tx<{value:Record<string,unknown>;provider_identity_public_key:string}[]>`
        SELECT to_jsonb(m) AS value,provider_identity_public_key FROM managed_custody_evidence m WHERE account_id=${row.account_id} FOR UPDATE`)[0];
      if(!account||account.did!==row.did||row.direction==="owner-to-managed"&&!portable||row.direction==="managed-to-owner"&&
        (!managed||managed.provider_identity_public_key!==row.old_identity_public_key))throw new Error("Account custody changed before materialization");
      const generation=number((await tx<{generation:number|string|bigint}[]>`SELECT generation FROM account_serving_generations WHERE account_id=${row.account_id} FOR UPDATE`)[0]!.generation,"generation");
      if(generation!==number(row.generation_from,"generation"))throw new Error("Serving generation changed before custody materialization");
      await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify({[row.account_id]:generation})},true)`;
      const successors=await tx<SuccessorRow[]>`SELECT * FROM custody_transition_grant_successors WHERE transition_id=${row.transition_id} ORDER BY grant_id`;
      for(const successor of successors) {
        const lineage=(await tx<{current_revision:number;current_digest:Uint8Array;current_status:string}[]>`SELECT current_revision,current_digest,current_status
          FROM grant_lineages WHERE grant_id=${successor.grant_id} AND local_account_id=${row.account_id} AND local_role='grantor' FOR UPDATE`)[0];
        const publication=(await tx<{state:string;acknowledged_etag:string|null}[]>`SELECT state,acknowledged_etag FROM grant_publications
          WHERE grant_id=${successor.grant_id} AND revision=${successor.predecessor_revision} FOR UPDATE`)[0];
        if(!lineage||lineage.current_status!=="active"||lineage.current_revision!==successor.predecessor_revision||
          !equal(lineage.current_digest,successor.predecessor_digest)||publication?.state!=="acknowledged"||!publication.acknowledged_etag)
          throw new Error("Acknowledged Grant predecessor changed before custody materialization");
      }
      let retired:Record<string,unknown>;
      if(row.direction==="owner-to-managed") {
        if(!row.encrypted_identity_private_key||!row.identity_encryption_nonce||row.identity_encryption_version!==1||!row.identity_kek_id)
          throw new Error("Managed identity material is missing");
        await tx`DELETE FROM portable_custody_evidence WHERE account_id=${row.account_id}`;
        await tx`INSERT INTO account_keys (account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
          VALUES (${row.account_id},'hail-identity','ed25519',${row.new_identity_public_key},${row.encrypted_identity_private_key},
            ${row.identity_encryption_nonce},${row.identity_encryption_version},${row.identity_kek_id})`;
        await tx`INSERT INTO managed_custody_evidence
          (account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
          VALUES (${row.account_id},${row.owner_recovery_public_key},${row.new_identity_public_key},'strict-public-v1',
            ${MANAGED_CUSTODY_PROFILE_VERSION})`;
        retired=portable!.value;
      } else {
        const previous=(await tx<{value:Record<string,unknown>}[]>`SELECT retired_custody_evidence AS value FROM custody_transition_preparations
          WHERE account_id=${row.account_id} AND direction='owner-to-managed' AND state='complete' ORDER BY completed_at DESC LIMIT 1`)[0]?.value;
        const onboarding=(await tx<{monitor_origin:string;monitor_public_key:string;activated_at:Date}[]>`
          SELECT monitor_origin,monitor_public_key,activated_at FROM public_onboarding_evidence WHERE account_id=${row.account_id}`)[0];
        const monitorOrigin=typeof previous?.monitor_origin==="string"?previous.monitor_origin:onboarding?.monitor_origin;
        const monitorKey=typeof previous?.monitor_public_key==="string"?previous.monitor_public_key:onboarding?.monitor_public_key;
        const monitorConfirmed=previous?.monitor_confirmed_at?new Date(String(previous.monitor_confirmed_at)):onboarding?.activated_at;
        if(!monitorOrigin||!monitorKey||!monitorConfirmed||!Number.isFinite(monitorConfirmed.getTime()))
          throw new Error("Independent monitor evidence is required for portable custody");
        await tx`DELETE FROM managed_custody_evidence WHERE account_id=${row.account_id}`;
        await tx`DELETE FROM account_keys WHERE account_id=${row.account_id} AND role='hail-identity' AND public_key=${row.old_identity_public_key}`;
        await tx`INSERT INTO portable_custody_evidence (account_id,user_recovery_public_key,user_identity_public_key,monitor_origin,
          monitor_public_key,monitor_confirmed_at,backup_confirmed_at,monitor_verification_mode) VALUES (${row.account_id},
          ${row.owner_recovery_public_key},${row.new_identity_public_key},${monitorOrigin},${monitorKey},${monitorConfirmed},clock_timestamp(),'independent')`;
        retired=managed!.value;
      }
      for(const successor of successors) {
        const payload=inspectSignedPayload("hail.grant",new Uint8Array(successor.successor_cose)).payload;
        await tx`INSERT INTO grant_revisions (grant_id,revision,status,issued_at,updated_at,expires_at,previous_digest,scope_payload,
          consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,
          signing_plc_document,signing_plc_data,signing_plc_operation_log) VALUES (${successor.grant_id},${successor.successor_revision},
          ${payload.status},${payload.issued_at},${payload.updated_at},${payload.expires_at},${payload.previous},(${JSON.stringify(payload.scope)}::text)::jsonb,
          ${payload.consent_context.address_binding_hash.value},${payload.consent_context.sender_profile_hash.value},${successor.successor_cose},
          ${successor.successor_digest},${row.new_identity_public_key},(${jsonEvidence(evidence.document)}::text)::jsonb,(${jsonEvidence(evidence.data)}::text)::jsonb,
          (${jsonEvidence(evidence.log)}::text)::jsonb)`;
        await retainPublicGrantAuthority(tx,{localAccountId:row.account_id,localRole:"grantor",payload,representation:successor.successor_cose,
          digest:successor.successor_digest,signingPublicKey:row.new_identity_public_key,signingPlcEvidence:evidence,expectedServiceBase:this.serviceBase});
        await tx`UPDATE grant_lineages SET current_revision=${successor.successor_revision},current_digest=${successor.successor_digest},updated_at=clock_timestamp()
          WHERE grant_id=${successor.grant_id}`;
        await tx`INSERT INTO grant_publications (grant_id,revision,destination_service_base)
          VALUES (${successor.grant_id},${successor.successor_revision},${successor.destination_service_base})`;
      }
      await tx`UPDATE address_bindings SET selected_at=NULL WHERE account_id=${row.account_id} AND selected_at IS NOT NULL`;
      await tx`INSERT INTO address_bindings (id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
        VALUES (${randomUUID()},${row.account_id},${account.canonical_address},${row.did},${row.binding_cose},${row.binding_digest},
          to_timestamp(${inspectSignedPayload("hail.address-binding",new Uint8Array(row.binding_cose)).payload.issued_at}),
          to_timestamp(${inspectSignedPayload("hail.address-binding",new Uint8Array(row.binding_cose)).payload.expires_at}),clock_timestamp(),clock_timestamp(),clock_timestamp())`;
      await retainPublicSigningAuthority(tx,{actionType:"address-binding",localAccountId:row.account_id,did:row.did,role:"hail-identity",
        key:row.new_identity_public_key,serviceBase:this.serviceBase,representation:row.binding_cose,evidence});
      await tx`INSERT INTO plc_operation_evidence (id,account_id,did,operation_cid,previous_cid,registry_origin,signed_operation,
        signed_operation_bytes,dag_cbor,expected_state,submission_state,submitted_at,verified_at) VALUES (${randomUUID()},${row.account_id},
          ${row.did},${cid},${row.previous_operation_cid},'https://plc.directory',(${JSON.stringify(operation)}::text)::jsonb,${operationBytes},${dagBytes},
          (${JSON.stringify(evidence.data)}::text)::jsonb,'verified',clock_timestamp(),clock_timestamp())`;
      await tx`UPDATE account_api_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=${row.account_id}`;
      for(const table of ["grant_publications","delivery_work","terminal_status_publications"] as const)
        await tx.unsafe(`UPDATE ${table} SET lease_token=NULL,lease_expires_at=NULL WHERE lease_token IN
          (SELECT lease_token FROM serving_worker_leases WHERE account_id=$1)`,[row.account_id]);
      await tx`DELETE FROM serving_worker_leases WHERE account_id=${row.account_id}`;
      await tx`UPDATE provider_accounts SET activation_binding_digest=${row.binding_digest},state_version=state_version+1,updated_at=clock_timestamp()
        WHERE id=${row.account_id}`;
      await tx`UPDATE custody_transition_preparations SET state='complete',retired_custody_evidence=(${JSON.stringify(retired)}::text)::jsonb,
        completed_at=clock_timestamp() WHERE transition_id=${row.transition_id}`;
      await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${row.account_id}`;
    });
    materializedServingGeneration(row.account_id,number(row.generation_to,"generation"));
  }

  private async grants(sql:SQL,accountId:string):Promise<GrantRow[]> {
    return sql<GrantRow[]>`SELECT lineage.grant_id,lineage.current_revision,lineage.current_digest,lineage.current_status,
      revision.cose,revision.representation_digest,revision.signing_public_key,publication.state AS publication_state,
      publication.destination_service_base,publication.acknowledged_etag FROM grant_lineages lineage
      JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id AND revision.revision=lineage.current_revision
      LEFT JOIN grant_publications publication ON publication.grant_id=lineage.grant_id AND publication.revision=lineage.current_revision
      WHERE lineage.local_account_id=${accountId} AND lineage.local_role='grantor' ORDER BY lineage.grant_id`;
  }
  private async history(sql:SQL,accountId:string) {
    const revisions=await sql<HistoryRow[]>`SELECT lineage.grant_id,revision.revision,lineage.current_revision AS lineage_current_revision,
      lineage.current_status AS lineage_current_status,revision.cose,revision.representation_digest,revision.signing_public_key,
      publication.state AS publication_state,publication.acknowledged_etag FROM grant_lineages lineage
      JOIN grant_revisions revision ON revision.grant_id=lineage.grant_id
      LEFT JOIN grant_publications publication ON publication.grant_id=revision.grant_id AND publication.revision=revision.revision
      WHERE lineage.local_account_id=${accountId} AND lineage.local_role='grantor' ORDER BY lineage.grant_id,revision.revision`;
    const bindings=await sql<{id:string;cose:Uint8Array;representation_digest:Uint8Array;selected_at:Date|null;published_at:Date|null}[]>`
      SELECT id,cose,representation_digest,selected_at,published_at FROM address_bindings WHERE account_id=${accountId} ORDER BY created_at,id`;
    return {revisions,bindings};
  }
  private async row(accountId:string,id:string) {
    const row=(await this.sql<TransitionRow[]>`SELECT * FROM custody_transition_preparations WHERE transition_id=${id} AND account_id=${accountId}`)[0];
    if(!row)throw new Error("Custody transition does not exist");return row;
  }
  private preparation(row:TransitionRow):CustodyTransitionPreparation {
    const state=parsedState(row.expected_state);
    return {transitionId:row.transition_id,accountId:row.account_id,did:row.did,direction:row.direction,
      ownerRecoveryKey:row.owner_recovery_public_key,oldIdentityKey:row.old_identity_public_key,newIdentityKey:row.new_identity_public_key,
      currentState:def.documentData.parse({...state,verificationMethods:{...state.verificationMethods,"hail-identity":row.old_identity_public_key}}),
      unsignedOperation:def.unsignedOperation.parse({type:"plc_operation",prev:row.previous_operation_cid,rotationKeys:state.rotationKeys,
        verificationMethods:state.verificationMethods,alsoKnownAs:state.alsoKnownAs,services:state.services}),
      previousOperationCid:row.previous_operation_cid,historyCheckpointDigest:row.history_checkpoint_digest,bindingCose:row.binding_cose,
      bindingDigest:row.binding_digest,generationFrom:number(row.generation_from,"generation"),generationTo:number(row.generation_to,"generation"),
      expiresAt:row.expires_at.toISOString()};
  }
  private reviewApproval(row:TransitionRow,value:CustodyTransitionApproval,cid:string,accepted=false) {
    const now=Math.floor(this.now().getTime()/1000);
    if(!value||value.type!=="hailp.custody-transition"||value.version!==1||value.transition_id!==row.transition_id||value.did!==row.did||
      value.direction!==row.direction||value.provider_service_base!==this.serviceBase||value.owner_recovery_key!==row.owner_recovery_public_key||
      value.old_identity_key!==row.old_identity_public_key||value.new_identity_key!==row.new_identity_public_key||
      value.previous_operation_cid!==row.previous_operation_cid||value.operation_cid!==cid||
      !equal(value.history_checkpoint_sha256,row.history_checkpoint_digest)||!equal(value.binding_sha256,row.binding_digest)||
      value.generation_from!==number(row.generation_from,"generation")||value.generation_to!==number(row.generation_to,"generation")||
      typeof value.nonce!=="string"||value.nonce.length<16||value.issued_at>now+300||!accepted&&value.expires_at<=now||
      value.expires_at-value.issued_at>3600)throw new Error("Owner approval does not match the exact prepared custody transition");
  }
}
