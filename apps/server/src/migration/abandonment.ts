import {createHash,randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {verifySignature} from "@atproto/crypto";
import {cidForCbor} from "@atproto/common";
import {assureValidSig,def,validateOperationLog} from "@did-plc/lib";
import {decodeDeterministic,encodeDeterministic,type HailValue} from "@hailproto/codec";
import type {SQL} from "bun";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import type {PlcDirectoryClient} from "../plc/client.js";
import {materializedServingGeneration,releasedServingReservation} from "../db/serving.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {assertPrivatePocRegistry} from "./poc-profile.js";
import {validateTransferManifest,type TransferManifest} from "./transfer.js";
import {decodeSignedRecord,encodeSignedRecord} from "./wire.js";
import type {SignedHandshake} from "./handshake.js";
import type {PortableAddressVerifier} from "./activation.js";

type RecordValue=Record<string,any>;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const input=(kind:string,bytes:Uint8Array)=>{const tag=new TextEncoder().encode(`${kind}.v1\0`),result=new Uint8Array(tag.length+bytes.length);result.set(tag);result.set(bytes,tag.length);return result;};
const raw=(value:unknown)=>{const signed=decodeSignedRecord(value);return {signed,payload:decodeDeterministic(signed.payloadBytes) as RecordValue};};
const hex=(value:unknown)=>{if(typeof value!=="string"||!/^\\x[0-9a-f]+$/.test(value))throw new Error("Missing retained bytes");return new Uint8Array(Buffer.from(value.slice(2),"hex"));};

// Internal private-POC coordination; deliberately not registered as public routes.
export class PrivatePocTransferAbandonment {
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly plc:PlcDirectoryClient,
    private readonly serviceBase:string,private readonly registry:string,private readonly address:PortableAddressVerifier) {assertPrivatePocRegistry(registry,serviceBase);}

  private async manifest(transfer:string,side:"source"|"target") {
    const rows=side==="source"?await this.sql<{manifest_bytes:Uint8Array}[]>`SELECT manifest_bytes FROM provider_migration_exports WHERE transfer_id=${transfer}`:
      await this.sql<{manifest_bytes:Uint8Array}[]>`SELECT manifest_bytes FROM pending_migration_imports WHERE transfer_id=${transfer}`;
    let bytes=rows[0]?.manifest_bytes;
    if(!bytes&&side==="target"){
      const archive=(await this.sql<RecordValue[]>`SELECT evidence FROM provider_transfer_abandonments WHERE transfer_id=${transfer} AND side='target'`)[0];
      if(archive)bytes=hex(archive.evidence.target_import.manifest_bytes);
    }
    if(!bytes)throw new Error("Abandonment requires a retained exported/staged snapshot");
    const manifest=validateTransferManifest(new Uint8Array(bytes));
    if(manifest.tables.portable_custody_evidence[0]?.monitor_verification_mode!=="poc-local"||
      this.serviceBase!==(side==="source"?manifest.sourceServiceBase:manifest.destinationServiceBase))throw new Error("Wrong private-POC abandonment side");
    return {manifest,digest:hash(new Uint8Array(bytes))};
  }
  private async owner(value:unknown,manifest:TransferManifest,digest:Uint8Array,kind:string,fresh=true) {
    const {signed,payload}=raw(value),fields=["type","version","did","transfer_id","source_service_base","destination_service_base","source_generation","snapshot_digest","cutover_operation_cid","user_recovery_key","nonce","issued_at","expires_at",
      ...(kind==="hailp.transfer-resume"?["protective_operation_cid","invalidation_digest"]:[])];
    if(!payload||Object.keys(payload).length!==fields.length||!fields.every(field=>Object.hasOwn(payload,field))||payload.type!==kind||payload.version!==1||
      payload.did!==manifest.did||payload.transfer_id!==manifest.transferId||payload.source_service_base!==manifest.sourceServiceBase||payload.destination_service_base!==manifest.destinationServiceBase||
      payload.user_recovery_key!==manifest.tables.portable_custody_evidence[0]!.user_recovery_public_key||!Number.isSafeInteger(payload.source_generation)||payload.source_generation<1||
      !(payload.snapshot_digest instanceof Uint8Array)||!same(payload.snapshot_digest,digest)||typeof payload.cutover_operation_cid!=="string"||payload.cutover_operation_cid.length>100||
      typeof payload.nonce!=="string"||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(payload.nonce)||!Number.isSafeInteger(payload.issued_at)||!Number.isSafeInteger(payload.expires_at)||
      payload.expires_at<=payload.issued_at||payload.expires_at-payload.issued_at>3600||fresh&&(payload.issued_at>Math.floor(Date.now()/1000)+300||payload.expires_at<=Math.floor(Date.now()/1000))||
      !same(signed.payloadBytes,encodeDeterministic(payload))||!await verifySignature(payload.user_recovery_key,input(kind,signed.payloadBytes),signed.signature,{jwtAlg:"ES256"}))throw new Error("Invalid independent owner abandonment/resumption approval");
    if(kind==="hailp.transfer-resume"&&(typeof payload.protective_operation_cid!=="string"||payload.protective_operation_cid.length>100||!(payload.invalidation_digest instanceof Uint8Array)||payload.invalidation_digest.length!==32))throw new Error("Invalid protective resumption binding");
    return {signed,payload};
  }
  private async receipt(value:unknown,kind:string,key:string) {
    const {signed,payload}=raw(value);
    if(payload?.type!==kind||payload.version!==1||!same(signed.payloadBytes,encodeDeterministic(payload))||
      !await crypto.subtle.verify("Ed25519",await ed25519PublicKeyFromDidKey(key),Uint8Array.from(signed.signature),input(kind,signed.payloadBytes)))throw new Error("Invalid coordination receipt signature");
    return {signed,payload};
  }
  private async sign(payload:RecordValue,secret:Uint8Array) {
    const bytes=encodeDeterministic(payload as HailValue);
    try{return encodeSignedRecord({payloadBytes:bytes,signature:new Uint8Array(await crypto.subtle.sign("Ed25519",await importEd25519PrivateKey(secret),input(payload.type,bytes)))});}
    finally{secret.fill(0);}
  }
  private async targetSign(tx:SQL,transfer:string,payload:RecordValue) {
    const key=(await tx<RecordValue[]>`SELECT * FROM prepared_migration_target_keys WHERE transfer_id=${transfer} FOR UPDATE`)[0];
    if(!key||key.state!=="staged")throw new Error("Prepared target is not reversible");
    const secret=await this.encryptor.decrypt(transfer,"hail-messaging","ed25519",key.messaging_public_key,
      {ciphertext:key.messaging_private_ciphertext,nonce:key.messaging_nonce,encryptionVersion:1,kekId:"poc-v1"});
    return this.sign(payload,secret);
  }
  async invalidate(intent:unknown) {
    const transfer=raw(intent).payload?.transfer_id;if(typeof transfer!=="string")throw new Error("Missing transfer ID");
    const {manifest,digest}=await this.manifest(transfer,"target"),approval=await this.owner(intent,manifest,digest,"hailp.transfer-abandon",false);
    return this.sql.begin(async tx=>{
      const pending=(await tx<RecordValue[]>`SELECT * FROM pending_migration_imports WHERE transfer_id=${transfer} FOR UPDATE`)[0];
      const prior=(await tx<RecordValue[]>`SELECT * FROM provider_transfer_abandonments WHERE transfer_id=${transfer}`)[0];
      if(prior){if(!isDeepStrictEqual(prior.evidence.intent,intent))throw new Error("Abandonment intent changed");return prior.evidence.invalidation;}
      await this.owner(intent,manifest,digest,"hailp.transfer-abandon");
      if(!pending||pending.state!=="staged"||pending.activated_at)throw new Error("An active/uncertain destination requires a latest-state reverse transfer");
      const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder().decode(pending.signed_plc_operation_bytes)));
      if((await cidForCbor(operation)).toString()!==approval.payload.cutover_operation_cid)throw new Error("Abandonment names another prepared PLC operation");
      const log=await this.plc.getOperationLog(manifest.did),current=await validateOperationLog(manifest.did,log),tip=log.at(-1);
      if(!current||!tip||current.rotationKeys[0]!==approval.payload.user_recovery_key||current.verificationMethods['hail-identity']!==manifest.tables.portable_custody_evidence[0]!.user_identity_public_key||
        ![operation.prev,approval.payload.cutover_operation_cid].includes((await cidForCbor(tip)).toString()))throw new Error("Unrecognized PLC authority requires separate recovery");
      await tx`UPDATE pending_migration_imports SET state='invalidated',invalidated_at=clock_timestamp() WHERE transfer_id=${transfer} AND state='staged'`;
      const receipt=await this.targetSign(tx,transfer,{type:"hailp.transfer-invalidated",version:1,did:manifest.did,transfer_id:transfer,snapshot_digest:digest,
        source_generation:approval.payload.source_generation,cutover_operation_cid:approval.payload.cutover_operation_cid,intent_digest:hash(approval.signed.payloadBytes),never_active:true,invalidated_at:Math.floor(Date.now()/1000)});
      const archived=(await tx<RecordValue[]>`SELECT to_jsonb(i) AS imported,to_jsonb(invitation) AS invitation,to_jsonb(reservation) AS reservation,
          to_jsonb(prepared)-'rotation_private_ciphertext'-'rotation_nonce'-'messaging_private_ciphertext'-'messaging_nonce' AS prepared,to_jsonb(observation) AS observation
        FROM pending_migration_imports i LEFT JOIN received_transfer_invitations invitation USING(transfer_id)
        LEFT JOIN transfer_address_reservations reservation USING(transfer_id) LEFT JOIN prepared_migration_target_keys prepared USING(transfer_id)
        LEFT JOIN portable_cutover_observations observation USING(transfer_id) WHERE i.transfer_id=${transfer}`)[0]!;
      await tx`INSERT INTO provider_transfer_abandonments (transfer_id,did,side,state,evidence) VALUES (${transfer},${manifest.did},'target','target-invalidated',
        (${JSON.stringify({intent,invalidation:receipt,target_import:archived.imported,invitation:archived.invitation,reservation:archived.reservation,prepared_public:archived.prepared,observation:archived.observation})}::text)::jsonb)`;
      return receipt;
    });
  }
  private async protective(bytes:Uint8Array,manifest:TransferManifest,resume:RecordValue) {
    if(!bytes.length||bytes.length>16000)throw new Error("Protective operation exceeds limit");
    const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));
    const baseline=manifest.tables.plc_operation_evidence.at(-1)!;
    const expected=typeof baseline.expected_state==="string"?JSON.parse(baseline.expected_state):baseline.expected_state;
    if((await cidForCbor(operation)).toString()!==resume.protective_operation_cid||![baseline.operation_cid,resume.cutover_operation_cid].includes(operation.prev)||
      !isDeepStrictEqual({rotationKeys:operation.rotationKeys,verificationMethods:operation.verificationMethods,services:operation.services,alsoKnownAs:operation.alsoKnownAs},
        {rotationKeys:expected.rotationKeys,verificationMethods:expected.verificationMethods,services:expected.services,alsoKnownAs:expected.alsoKnownAs}))throw new Error("Protective operation does not restore the exact approved source state");
    await assureValidSig([resume.user_recovery_key],operation);
    const log=await this.plc.getOperationLog(manifest.did),state=await validateOperationLog(manifest.did,log);
    const last=log.at(-1);if(!state||!last||(await cidForCbor(last)).toString()!==resume.protective_operation_cid||state.rotationKeys[0]!==resume.user_recovery_key||
      state.services.hail?.endpoint!==manifest.sourceServiceBase||state.verificationMethods["hail-messaging"]!==expected.verificationMethods["hail-messaging"])throw new Error("The exact protective source operation is not current");
    const baseIndex=await Promise.all(log.map(op=>cidForCbor(op))).then(cids=>cids.findIndex(cid=>cid.toString()===baseline.operation_cid));
    if(baseIndex<0||(await Promise.all(log.slice(baseIndex+1).map(op=>cidForCbor(op)))).some(cid=>![resume.cutover_operation_cid,resume.protective_operation_cid].includes(cid.toString())))throw new Error("Unrecognized PLC changes require separate recovery");
    return {operation,state};
  }
  async release(resume:unknown,operationBytes:Uint8Array) {
    const transfer=raw(resume).payload?.transfer_id;if(typeof transfer!=="string")throw new Error("Missing transfer ID");
    const {manifest,digest}=await this.manifest(transfer,"target"),approval=await this.owner(resume,manifest,digest,"hailp.transfer-resume",false);
    await this.protective(operationBytes,manifest,approval.payload);
    let reserved="";
    const receipt=await this.sql.begin(async tx=>{
      const pending=(await tx<RecordValue[]>`SELECT * FROM pending_migration_imports WHERE transfer_id=${transfer} FOR UPDATE`)[0];
      const record=(await tx<RecordValue[]>`SELECT * FROM provider_transfer_abandonments WHERE transfer_id=${transfer} FOR UPDATE`)[0];
      if(!record||record.side!=="target")throw new Error("Target is not durably invalidated");
      if(record.state==="target-released"){if(!isDeepStrictEqual(record.evidence.resume,resume))throw new Error("Resumption approval changed");return record.evidence.release;}
      if(pending?.state!=="invalidated")throw new Error("Target is not durably invalidated");
      await this.owner(resume,manifest,digest,"hailp.transfer-resume");
      const invalidation=raw(record.evidence.invalidation);
      if(!same(hash(invalidation.signed.payloadBytes),approval.payload.invalidation_digest)||approval.payload.cutover_operation_cid!==invalidation.payload.cutover_operation_cid||
        approval.payload.source_generation!==invalidation.payload.source_generation)throw new Error("Resumption does not bind the retained invalidation");
      const reservation=(await tx<RecordValue[]>`SELECT * FROM transfer_address_reservations WHERE transfer_id=${transfer} FOR UPDATE`)[0];
      if(reservation){reserved=reservation.reserved_account_id;
        await tx`DELETE FROM address_bindings WHERE account_id=${reserved} AND did=${manifest.did}`;
        await tx`DELETE FROM transfer_address_reservations WHERE transfer_id=${transfer}`;
        const removed=await tx`DELETE FROM provider_accounts WHERE id=${reserved} AND did IS NULL AND onboarding_state='reserved' RETURNING id`;
        if(removed.length!==1)throw new Error("Target reservation no longer reversible");}
      const released=await this.targetSign(tx,transfer,{type:"hailp.transfer-released",version:1,did:manifest.did,transfer_id:transfer,snapshot_digest:digest,
        source_generation:approval.payload.source_generation,cutover_operation_cid:approval.payload.cutover_operation_cid,protective_operation_cid:approval.payload.protective_operation_cid,
        invalidation_digest:approval.payload.invalidation_digest,resume_digest:hash(approval.signed.payloadBytes),never_active:true,released_at:Math.floor(Date.now()/1000)});
      await tx`UPDATE provider_transfer_abandonments SET state='target-released',evidence=(${JSON.stringify({...record.evidence,resume,release:released})}::text)::jsonb WHERE transfer_id=${transfer}`;
      const invitation=record.evidence.invitation;
      if(invitation)await tx`INSERT INTO cancelled_transfer_sessions (did,nonce,grant_digest,receipt_digest)
        VALUES (${manifest.did},${invitation.nonce},${hex(invitation.grant_digest)},${hash(raw(released).signed.payloadBytes)}) ON CONFLICT(did,nonce) DO NOTHING`;
      await tx`DELETE FROM received_transfer_invitations WHERE transfer_id=${transfer}`;
      await tx`DELETE FROM portable_cutover_observations WHERE transfer_id=${transfer}`;
      await tx`DELETE FROM pending_migration_imports WHERE transfer_id=${transfer}`;
      await tx`DELETE FROM prepared_migration_target_keys WHERE transfer_id=${transfer}`;
      return released;
    });
    if(reserved)releasedServingReservation(reserved);return receipt;
  }
  async resume(resume:unknown,release:unknown,operationBytes:Uint8Array) {
    const transfer=raw(resume).payload?.transfer_id;if(typeof transfer!=="string")throw new Error("Missing transfer ID");
    const prior=(await this.sql<RecordValue[]>`SELECT * FROM provider_transfer_abandonments WHERE transfer_id=${transfer}`)[0];
    if(prior&&prior.side!=="source")throw new Error("Wrong resumption source");
    const {manifest,digest}=prior?{manifest:validateTransferManifest(hex(prior.evidence.export.manifest_bytes)),digest:hex(prior.evidence.export.manifest_digest)}:await this.manifest(transfer,"source");
    const approval=await this.owner(resume,manifest,digest,"hailp.transfer-resume",false),protectedState=await this.protective(operationBytes,manifest,approval.payload);
    if(this.serviceBase!==manifest.sourceServiceBase)throw new Error("Wrong resumption source");
    if(prior){if(prior.side!=="source"||!isDeepStrictEqual(prior.evidence.resume,resume)||!isDeepStrictEqual(prior.evidence.release,release))throw new Error("Completed resumption evidence changed");
      const generation=Number((await this.sql<RecordValue[]>`SELECT generation FROM account_serving_generations WHERE account_id=${manifest.accountId}`)[0]?.generation);
      if(generation!==approval.payload.source_generation+1||(await this.sql`SELECT did FROM provider_migration_fences WHERE did=${manifest.did}`).length)throw new Error("Resumed ownership has since changed");
      return prior.evidence.receipt;}
    const verifiedAddress=await this.address.verify(manifest.tables.provider_accounts[0]!.canonical_address as string);
    if(verifiedAddress.did!==manifest.did||verifiedAddress.serviceBase!==manifest.sourceServiceBase||verifiedAddress.identityDidKey!==manifest.tables.portable_custody_evidence[0]!.user_identity_public_key)throw new Error("Source binding does not verify");
    const result=await this.sql.begin(async tx=>{
      await tx`SELECT id FROM provider_accounts WHERE id=${manifest.accountId} AND did=${manifest.did} FOR UPDATE`;
      const fence=(await tx<RecordValue[]>`SELECT f.*,to_jsonb(f) AS record FROM provider_migration_fences f WHERE transfer_id=${transfer} AND account_id=${manifest.accountId} FOR UPDATE`)[0];
      const exported=(await tx<RecordValue[]>`SELECT to_jsonb(e) AS value FROM provider_migration_exports e WHERE transfer_id=${transfer}`)[0]?.value;
      const authorization=(await tx<RecordValue[]>`SELECT to_jsonb(a) AS value FROM provider_transfer_authorizations a WHERE did=${manifest.did} AND consumed_transfer_id=${transfer}`)[0]?.value;
      const generation=Number((await tx<RecordValue[]>`SELECT generation FROM account_serving_generations WHERE account_id=${manifest.accountId}`)[0]?.generation);
      if(!fence||fence.state!=="exported"||!exported||generation!==approval.payload.source_generation||!same(fence.snapshot_digest,digest))throw new Error("Source resumption lacks the exact frozen generation/export");
      const receipt=await this.receipt(release,"hailp.transfer-released",fence.destination_messaging_public_key),payload=receipt.payload;
      if(payload.did!==manifest.did||payload.transfer_id!==transfer||payload.never_active!==true||payload.source_generation!==generation||
        payload.cutover_operation_cid!==approval.payload.cutover_operation_cid||payload.protective_operation_cid!==approval.payload.protective_operation_cid||
        !same(payload.snapshot_digest,digest)||!same(payload.resume_digest,hash(approval.signed.payloadBytes))||!same(payload.invalidation_digest,approval.payload.invalidation_digest)||
        !Number.isSafeInteger(payload.released_at)||payload.released_at<approval.payload.issued_at-300||payload.released_at>approval.payload.expires_at||payload.released_at>Math.floor(Date.now()/1000)+300)throw new Error("Target release does not bind this accepted owner resumption");
      const latest=(await this.plc.getOperationLog(manifest.did)).at(-1)!;
      if((await cidForCbor(latest)).toString()!==approval.payload.protective_operation_cid)throw new Error("Protective PLC authority changed before source resumption");
      const key=(await tx<RecordValue[]>`SELECT * FROM account_keys WHERE account_id=${manifest.accountId} AND role='hail-messaging'`)[0];
      if(!key||key.public_key!==protectedState.state.verificationMethods["hail-messaging"])throw new Error("Source messaging authority changed");
      const secret=await this.encryptor.decrypt(manifest.accountId,"hail-messaging","ed25519",key.public_key,{ciphertext:key.encrypted_private_key,nonce:key.encryption_nonce,encryptionVersion:key.encryption_version,kekId:key.kek_id});
      const sourceReceipt=await this.sign({type:"hailp.transfer-resumed",version:1,did:manifest.did,transfer_id:transfer,snapshot_digest:digest,protective_operation_cid:approval.payload.protective_operation_cid,
        source_generation:generation+1,resume_digest:hash(approval.signed.payloadBytes),release_digest:hash(receipt.signed.payloadBytes)},secret);
      await tx`INSERT INTO provider_transfer_abandonments (transfer_id,did,side,state,evidence) VALUES (${transfer},${manifest.did},'source','source-resumed',
        (${JSON.stringify({resume,release,receipt:sourceReceipt,fence:fence.record,export:exported,authorization})}::text)::jsonb)`;
      await tx`DELETE FROM provider_migration_exports WHERE transfer_id=${transfer}`;
      await tx`DELETE FROM provider_migration_fences WHERE transfer_id=${transfer}`;
      await tx`DELETE FROM provider_transfer_authorizations WHERE did=${manifest.did} AND consumed_transfer_id=${transfer}`;
      await tx`UPDATE account_api_credentials SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE account_id=${manifest.accountId}`;
      await tx`UPDATE grant_publications SET lease_token=NULL,lease_expires_at=NULL WHERE grant_id IN (SELECT grant_id FROM grant_lineages WHERE local_account_id=${manifest.accountId})`;
      for(const table of ["delivery_work","terminal_status_publications"])await tx.unsafe(`UPDATE "${table}" SET lease_token=NULL,lease_expires_at=NULL WHERE (sender_did,message_id) IN (SELECT sender_did,message_id FROM received_envelopes WHERE local_account_id=$1)`,[manifest.accountId]);
      await tx`DELETE FROM serving_worker_leases WHERE account_id=${manifest.accountId}`;
      await tx`SELECT set_config('hail.returning_account',${manifest.accountId},true)`;
      await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${manifest.accountId}`;
      const contexts=(await tx<RecordValue[]>`SELECT current_setting('hail.admitted_generations',true) AS value`)[0];
      const admitted=JSON.parse(contexts?.value||"{}");admitted[manifest.accountId]=generation+1;
      await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify(admitted)},true)`;
      const op=protectedState.operation;
      await tx`INSERT INTO plc_operation_evidence (id,account_id,did,operation_cid,previous_cid,registry_origin,signed_operation,signed_operation_bytes,dag_cbor,expected_state,submission_state,submitted_at,verified_at)
        VALUES (${randomUUID()},${manifest.accountId},${manifest.did},${approval.payload.protective_operation_cid},${op.prev},${this.registry},
          ${JSON.stringify(op)}::jsonb,${operationBytes},${new Uint8Array((await import('@ipld/dag-cbor')).encode(op))},${JSON.stringify(protectedState.state)}::jsonb,'verified',now(),now())`;
      return {receipt:sourceReceipt,generation:generation+1};
    });
    materializedServingGeneration(manifest.accountId,result.generation);return result.receipt;
  }
}
