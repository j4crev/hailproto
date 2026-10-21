import {createHash,randomUUID} from "node:crypto";
import * as dagCbor from "@ipld/dag-cbor";
import {cidForCbor} from "@atproto/common";
import {def} from "@did-plc/lib";
import {createWebCryptoSigner,createWebCryptoVerifier,inspectSignedPayload,signPayload,verifySignedPayload,
  type HailGrant,type HailSenderProfile} from "@hailproto/codec";
import type {SQL} from "bun";
import {materializedServingGeneration} from "../db/serving.js";
import type {KeyEncryptor} from "../identity/key-encryption.js";
import {ed25519PublicKeyFromDidKey} from "../identity/did-key.js";
import {importEd25519PrivateKey} from "../identity/keys.js";
import {MANAGED_CUSTODY_PROFILE_VERSION} from "../identity/managed-profile.js";
import type {AddressVerificationService} from "../onboarding/activation.js";
import {retainPublicGrantAuthority} from "../plc/grant-authority.js";
import type {HailDidResolver,PlcResolutionEvidence} from "../plc/resolver.js";
import {retainPublicSigningAuthority} from "../plc/signing-authority.js";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {validateManagedTransferManifest,type ManagedTransferManifest} from "./managed-snapshot.js";
import {signActivationReceipt,type SignedActivationReceipt} from "./activation-receipt.js";
import {replaceRetiredManagedProjection} from "./return.js";
import type {PortableCutoverGate} from "./cutover-gate.js";
import type {SignedMonitorAttestation} from "./monitor-attestation.js";
import {requirePublicCutoverEvidence} from "./public-cutover-evidence.js";

type Row=Record<string,unknown>;
const sha=(value:Uint8Array)=>new Uint8Array(createHash("sha256").update(value).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
function bytes(value:unknown) {if(typeof value!=="string"||!/^\\x(?:[0-9a-f]{2})+$/i.test(value))throw new Error("Managed history contains invalid database bytes");return new Uint8Array(Buffer.from(value.slice(2),"hex"));}
async function insert(sql:SQL,table:string,row:Row) {
  await sql.unsafe(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", ($1::text)::jsonb)`,[JSON.stringify(row)]);
}
async function insertImmutable(sql:SQL,table:string,row:Row) {
  await sql.unsafe(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", ($1::text)::jsonb) ON CONFLICT DO NOTHING`,[JSON.stringify(row)]);
}

interface PreparedRow {
  state:string;custody_profile:string;rotation_public_key:string;rotation_private_ciphertext:Uint8Array;rotation_nonce:Uint8Array;
  identity_public_key:string|null;identity_private_ciphertext:Uint8Array|null;identity_nonce:Uint8Array|null;
  messaging_public_key:string;messaging_private_ciphertext:Uint8Array;messaging_nonce:Uint8Array;
}

export class ManagedMigrationActivation {
  constructor(private readonly sql:SQL,private readonly encryptor:KeyEncryptor,private readonly resolver:HailDidResolver,
    private readonly verifier:AddressVerificationService,private readonly serviceBase:string,private readonly registryOrigin:string,
    private readonly verificationMode:"strict-public-v1"|"poc-local"="strict-public-v1",private readonly now=()=>new Date(),
    private readonly gate?:Pick<PortableCutoverGate,"assess">) {
    if(verificationMode==="strict-public-v1"&&(registryOrigin!=="https://plc.directory"||!gate))
      throw new Error("Public managed activation requires the canonical registry and public cutover gate");
    if(verificationMode==="poc-local"&&registryOrigin==="https://plc.directory")throw new Error("Private managed activation cannot use the public registry");
  }

  async issueReceipt(transferId:string):Promise<SignedActivationReceipt> {
    const row=(await this.sql<{state:string;did:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;
      destination_address:string;destination_binding_digest:Uint8Array;signed_plc_operation_bytes:Uint8Array;activated_at:Date}[]>`
      SELECT state,did,manifest_bytes,manifest_digest,destination_address,destination_binding_digest,
        signed_plc_operation_bytes,activated_at FROM pending_migration_imports WHERE transfer_id=${transferId}`)[0];
    if(!row||row.state!=="active"||!row.activated_at)throw new Error("Only an active managed import may acknowledge destination takeover");
    const manifest=validateManagedTransferManifest(row.manifest_bytes);
    if(this.verificationMode==="strict-public-v1")await requirePublicCutoverEvidence(this.sql,{transferId,did:row.did,
      manifestDigest:row.manifest_digest,operationBytes:row.signed_plc_operation_bytes,activatedAt:row.activated_at});
    if(manifest.transferId!==transferId||manifest.did!==row.did||manifest.destinationServiceBase!==this.serviceBase||
      !same(sha(row.manifest_bytes),row.manifest_digest))throw new Error("Active managed import differs from its retained snapshot");
    const resolved=await this.confirmCurrent(manifest,row.signed_plc_operation_bytes);
    const key=(await this.sql<{encrypted_private_key:Uint8Array;encryption_nonce:Uint8Array;public_key:string}[]>`
      SELECT encrypted_private_key,encryption_nonce,public_key FROM account_keys
      WHERE account_id=${manifest.accountId} AND role='hail-messaging'`)[0];
    if(!key||key.public_key!==manifest.destinationMessagingPublicKey||key.public_key!==resolved.messagingDidKey)
      throw new Error("Current managed destination messaging key is unavailable");
    const plaintext=await this.encryptor.decrypt(manifest.accountId,"hail-messaging","ed25519",key.public_key,
      {ciphertext:key.encrypted_private_key,nonce:key.encryption_nonce,encryptionVersion:1,kekId:"poc-v1"});
    try {return signActivationReceipt({type:"hail.portable-migration-activated",version:1,did:manifest.did,
      transfer_id:transferId,snapshot_digest:new Uint8Array(row.manifest_digest),destination_service_base:this.serviceBase,
      destination_messaging_key:key.public_key,destination_address:row.destination_address,
      address_binding_digest:new Uint8Array(row.destination_binding_digest),activated_at:Math.floor(row.activated_at.getTime()/1000)},
    await importEd25519PrivateKey(plaintext));} finally {plaintext.fill(0);}
  }

  async activate(transferId:string,signedMonitor?:SignedMonitorAttestation) {
    const pending=(await this.sql<{state:string;did:string;manifest_bytes:Uint8Array;manifest_digest:Uint8Array;
      destination_address:string;destination_binding_cose:Uint8Array;destination_binding_digest:Uint8Array;
      signed_plc_operation_bytes:Uint8Array;custody_profile:string}[]>`
      SELECT state,did,manifest_bytes,manifest_digest,destination_address,destination_binding_cose,
        destination_binding_digest,signed_plc_operation_bytes,custody_profile
      FROM pending_migration_imports WHERE transfer_id=${transferId}`)[0];
    if(pending?.state==="active") {
      const manifest=validateManagedTransferManifest(pending.manifest_bytes),account=(await this.sql<{id:string;canonical_address:string;
        activation_binding_digest:Uint8Array;generation:number|string;owner_recovery_public_key:string;provider_identity_public_key:string}[]>`
        SELECT account.id,account.canonical_address,account.activation_binding_digest,generation.generation,
          custody.owner_recovery_public_key,custody.provider_identity_public_key
        FROM provider_accounts account JOIN account_serving_generations generation ON generation.account_id=account.id
        JOIN managed_custody_evidence custody ON custody.account_id=account.id
        WHERE account.id=${manifest.accountId} AND account.did=${manifest.did} AND account.onboarding_state='active'`)[0];
      const keys=await this.sql<{role:string;public_key:string}[]>`SELECT role,public_key FROM account_keys WHERE account_id=${manifest.accountId}`;
      if(!account||account.canonical_address!==pending.destination_address||!same(account.activation_binding_digest,pending.destination_binding_digest)||
        Number(account.generation)!==manifest.sourceGeneration+1||account.owner_recovery_public_key!==manifest.ownerRecoveryPublicKey||
        account.provider_identity_public_key!==manifest.destinationIdentityPublicKey||keys.length!==3||
        !keys.some(key=>key.role==="plc-rotation"&&key.public_key===manifest.destinationRotationPublicKey)||
        !keys.some(key=>key.role==="hail-identity"&&key.public_key===manifest.destinationIdentityPublicKey)||
        !keys.some(key=>key.role==="hail-messaging"&&key.public_key===manifest.destinationMessagingPublicKey))
        throw new Error("Activated managed import no longer owns its exact account state");
      await this.confirmCurrent(manifest,pending.signed_plc_operation_bytes);
      if(this.verificationMode==="strict-public-v1")await this.issueReceipt(transferId);
      return {did:manifest.did,accountId:manifest.accountId,generation:manifest.sourceGeneration+1};
    }
    if(!pending||pending.state!=="staged"||pending.custody_profile!=="managed")throw new Error("No inactive managed import to materialize");
    const manifest=validateManagedTransferManifest(pending.manifest_bytes);
    if(manifest.transferId!==transferId||manifest.did!==pending.did||manifest.destinationServiceBase!==this.serviceBase||
      !same(sha(pending.manifest_bytes),pending.manifest_digest))throw new Error("Managed import differs from its retained snapshot");
    const assessment=this.gate?await this.gate.assess(transferId,signedMonitor):undefined;
    if(this.verificationMode==="strict-public-v1"&&(!assessment?.eligible||!assessment.evidenceDigest))
      throw new Error("Managed public cutover is not eligible");
    const resolved=await this.confirmCurrent(manifest,pending.signed_plc_operation_bytes);
    const prepared=(await this.sql<PreparedRow[]>`SELECT state,custody_profile,rotation_public_key,rotation_private_ciphertext,rotation_nonce,
      identity_public_key,identity_private_ciphertext,identity_nonce,messaging_public_key,messaging_private_ciphertext,messaging_nonce
      FROM prepared_migration_target_keys WHERE transfer_id=${transferId}`)[0];
    if(!prepared||prepared.state!=="staged"||prepared.custody_profile!=="managed"||
      prepared.rotation_public_key!==manifest.destinationRotationPublicKey||prepared.identity_public_key!==manifest.destinationIdentityPublicKey||
      prepared.messaging_public_key!==manifest.destinationMessagingPublicKey||!prepared.identity_private_ciphertext||!prepared.identity_nonce)
      throw new Error("Prepared managed destination keys changed before materialization");
    const binding=(await verifySignedPayload("hail.address-binding",pending.destination_binding_cose,
      createWebCryptoVerifier(kid=>{if(kid!==`${manifest.did}#hail-identity`)throw new Error("Managed binding has another signer");
        return ed25519PublicKeyFromDidKey(manifest.destinationIdentityPublicKey);}))).payload;
    if(binding.did!==manifest.did||binding.address!==pending.destination_address||binding.expires_at<=Math.floor(this.now().getTime()/1000)||
      !same(sha(pending.destination_binding_cose),pending.destination_binding_digest))throw new Error("Managed destination binding is stale or changed");
    await this.publishReservedBinding(transferId,manifest,pending,binding);
    const published=await this.verifier.verify(pending.destination_address);
    if(published.address!==pending.destination_address||published.did!==manifest.did||published.serviceBase!==this.serviceBase||
      published.identityDidKey!==manifest.destinationIdentityPublicKey||published.messagingDidKey!==manifest.destinationMessagingPublicKey||
      !same(published.representation,pending.destination_binding_cose)||!same(published.digest,pending.destination_binding_digest))
      throw new Error("Published address does not select the exact managed destination binding");
    const decrypt=async(role:"plc-rotation"|"hail-identity"|"hail-messaging",algorithm:"p256"|"ed25519",publicKey:string,
      ciphertext:Uint8Array,nonce:Uint8Array)=>this.encryptor.decrypt(transferId,role,algorithm,publicKey,
        {ciphertext,nonce,encryptionVersion:1,kekId:"poc-v1"});
    const [rotationBytes,identityBytes,messagingBytes]=await Promise.all([
      decrypt("plc-rotation","p256",prepared.rotation_public_key,prepared.rotation_private_ciphertext,prepared.rotation_nonce),
      decrypt("hail-identity","ed25519",prepared.identity_public_key,prepared.identity_private_ciphertext,prepared.identity_nonce),
      decrypt("hail-messaging","ed25519",prepared.messaging_public_key,prepared.messaging_private_ciphertext,prepared.messaging_nonce),
    ]);
    let encryptedRotation,encryptedIdentity,encryptedMessaging,identityKey:CryptoKey,messagingKey:CryptoKey;
    try {
      [encryptedRotation,encryptedIdentity,encryptedMessaging,identityKey,messagingKey]=await Promise.all([
        this.encryptor.encrypt(manifest.accountId,"plc-rotation","p256",prepared.rotation_public_key,rotationBytes),
        this.encryptor.encrypt(manifest.accountId,"hail-identity","ed25519",prepared.identity_public_key,identityBytes),
        this.encryptor.encrypt(manifest.accountId,"hail-messaging","ed25519",prepared.messaging_public_key,messagingBytes),
        importEd25519PrivateKey(identityBytes),importEd25519PrivateKey(messagingBytes),
      ]);
    } finally {rotationBytes.fill(0);identityBytes.fill(0);messagingBytes.fill(0);}
    const generation=manifest.sourceGeneration+1,activatedAt=this.now();let reservedId="";
    const result=await this.sql.begin(async tx=>{
      const locked=(await tx<{state:string;manifest_bytes:Uint8Array;signed_plc_operation_bytes:Uint8Array}[]>`
        SELECT state,manifest_bytes,signed_plc_operation_bytes FROM pending_migration_imports WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      const target=(await tx<{state:string}[]>`SELECT state FROM prepared_migration_target_keys WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      const reservation=(await tx<{reserved_account_id:string|null;canonical_address:string;state:string}[]>`
        SELECT reserved_account_id,canonical_address,state FROM transfer_address_reservations WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      if(!locked||locked.state!=="staged"||!same(locked.manifest_bytes,pending.manifest_bytes)||
        !same(locked.signed_plc_operation_bytes,pending.signed_plc_operation_bytes)||target?.state!=="staged"||
        !reservation?.reserved_account_id||reservation.canonical_address!==pending.destination_address||reservation.state!=="submitted")
        throw new Error("Managed staging authority changed before materialization");
      reservedId=reservation.reserved_account_id;
      if(this.verificationMode==="strict-public-v1") {
        const evidence=await requirePublicCutoverEvidence(tx,{transferId,did:manifest.did,manifestDigest:pending.manifest_digest,
          operationBytes:pending.signed_plc_operation_bytes,digest:assessment!.evidenceDigest,activatedAt:null});
        const age=this.now().getTime()-evidence.verified_at.getTime();
        if(age<0||age>30_000)throw new Error("Managed public cutover evidence expired before materialization");
      }
      const accounts=await tx<{id:string;did:string|null}[]>`SELECT id,did FROM provider_accounts
        WHERE did=${manifest.did} OR id=${manifest.accountId} FOR UPDATE`;
      const returning=accounts.length>0;
      if(returning&&(accounts.length!==1||accounts[0]?.id!==manifest.accountId||accounts[0].did!==manifest.did))
        throw new Error("Destination has conflicting managed DID or account ownership");
      if(returning)await replaceRetiredManagedProjection(tx,manifest);
      else await tx`SELECT set_config('hail.managed_migration',${manifest.accountId},true)`;
      await tx`DELETE FROM address_bindings WHERE account_id=${reservation.reserved_account_id} AND canonical_address=${pending.destination_address}`;
      const released=await tx`DELETE FROM provider_accounts WHERE id=${reservation.reserved_account_id} AND did IS NULL AND onboarding_state='reserved' RETURNING id`;
      if(released.length!==1)throw new Error("Destination address reservation was assigned elsewhere");
      if(returning)await tx`UPDATE provider_accounts SET canonical_address=${pending.destination_address},onboarding_state='active',
        activated_at=${activatedAt},activation_binding_digest=${pending.destination_binding_digest},activation_verification_mode='public',updated_at=${activatedAt}
        WHERE id=${manifest.accountId} AND did=${manifest.did}`;
      else {
        await insert(tx,"provider_accounts",{...manifest.tables.provider_accounts[0]!,canonical_address:pending.destination_address,
          onboarding_state:"active",activated_at:activatedAt.toISOString(),activation_binding_digest:`\\x${Buffer.from(pending.destination_binding_digest).toString("hex")}`,
          activation_verification_mode:"public",updated_at:activatedAt.toISOString()});
        await tx`UPDATE account_serving_generations SET generation=${generation} WHERE account_id=${manifest.accountId}`;
      }
      await tx`SELECT set_config('hail.admitted_generations',${JSON.stringify({[manifest.accountId]:generation})},true)`;
      for(const [role,algorithm,publicKey,material] of [
        ["plc-rotation","p256",manifest.destinationRotationPublicKey,encryptedRotation],
        ["hail-identity","ed25519",manifest.destinationIdentityPublicKey,encryptedIdentity],
        ["hail-messaging","ed25519",manifest.destinationMessagingPublicKey,encryptedMessaging],
      ] as const)await tx`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${manifest.accountId},${role},${algorithm},${publicKey},${material.ciphertext},${material.nonce},1,'poc-v1')`;
      await tx`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
        VALUES(${manifest.accountId},${manifest.ownerRecoveryPublicKey},${manifest.destinationIdentityPublicKey},${this.verificationMode},
          ${MANAGED_CUSTODY_PROFILE_VERSION})`;
      for(const row of manifest.tables.public_plc_resolution_evidence)await insertImmutable(tx,"public_plc_resolution_evidence",row);
      for(const table of ["plc_operation_evidence","address_bindings","sender_profiles"] as const)
        for(const row of manifest.tables[table])await insert(tx,table,table==="address_bindings"?{...row,selected_at:null}:row);
      const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(pending.signed_plc_operation_bytes)));
      const operationCid=(await cidForCbor(operation)).toString();
      await tx`INSERT INTO plc_operation_evidence(id,account_id,did,operation_cid,previous_cid,registry_origin,signed_operation,
        signed_operation_bytes,dag_cbor,expected_state,submission_state,submitted_at,verified_at)
        VALUES(${randomUUID()},${manifest.accountId},${manifest.did},${operationCid},${operation.prev},${this.registryOrigin},
          ${JSON.stringify(operation)}::jsonb,${pending.signed_plc_operation_bytes},${new Uint8Array(dagCbor.encode(operation))},
          ${JSON.stringify(resolved.evidence.data)}::jsonb,'verified',${activatedAt},${activatedAt})`;
      await tx`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
        VALUES(${randomUUID()},${manifest.accountId},${pending.destination_address},${manifest.did},${pending.destination_binding_cose},
          ${pending.destination_binding_digest},${new Date(binding.issued_at*1000)},${new Date(binding.expires_at*1000)},${activatedAt},${activatedAt},${activatedAt})`;
      await retainPublicSigningAuthority(tx,{actionType:"address-binding",localAccountId:manifest.accountId,did:manifest.did,
        role:"hail-identity",key:manifest.destinationIdentityPublicKey,serviceBase:this.serviceBase,
        representation:pending.destination_binding_cose,evidence:resolved.evidence});
      await this.importGrants(tx,manifest,identityKey,resolved.evidence,activatedAt);
      for(const table of ["detached_bodies","body_authorizations"] as const)for(const row of manifest.tables[table])await insert(tx,table,row);
      await this.importEnvelopes(tx,manifest);
      for(const table of ["reply_capabilities","delivery_work","verified_body_provenance","delivered_messages",
        "delivery_status_payloads","delivery_status_wrappers","terminal_status_publications","sent_delivery_status"] as const)
        for(const row of manifest.tables[table])await insert(tx,table,row);
      for(const table of ["public_envelope_authority_evidence","public_grant_authority_evidence","public_signing_authority_evidence"] as const)
        for(const row of manifest.tables[table])await insertImmutable(tx,table,row);
      await this.refreshProfile(tx,manifest,messagingKey,resolved.evidence,activatedAt);
      const activated=await tx`UPDATE pending_migration_imports SET state='active',activated_at=${activatedAt}
        WHERE transfer_id=${transferId} AND state='staged' RETURNING transfer_id`;
      const owned=await tx`UPDATE prepared_migration_target_keys SET state='active' WHERE transfer_id=${transferId} AND state='staged' RETURNING transfer_id`;
      if(activated.length!==1||owned.length!==1)throw new Error("Managed destination ownership changed during materialization");
      await tx`UPDATE transfer_address_reservations SET state='active' WHERE transfer_id=${transferId}`;
      return {did:manifest.did,accountId:manifest.accountId,generation};
    });
    materializedServingGeneration(manifest.accountId,generation,reservedId);return result;
  }

  private async confirmCurrent(manifest:ManagedTransferManifest,operationBytes:Uint8Array) {
    const operation=def.operation.parse(parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(operationBytes)));
    const cid=(await cidForCbor(operation)).toString(),resolved=await this.resolver.resolve(manifest.did);
    if(resolved.evidence.verification?.profile!==this.verificationMode||resolved.evidence.verification.operationCid!==cid||resolved.did!==manifest.did||
      resolved.serviceBase!==this.serviceBase||resolved.identityDidKey!==manifest.destinationIdentityPublicKey||
      resolved.messagingDidKey!==manifest.destinationMessagingPublicKey)
      throw new Error("Validated public reader does not confirm the materialized managed destination");
    return resolved;
  }

  private async publishReservedBinding(transferId:string,manifest:ManagedTransferManifest,pending:{destination_address:string;
    destination_binding_cose:Uint8Array;destination_binding_digest:Uint8Array},binding:{issued_at:number;expires_at:number}) {
    await this.sql.begin(async tx=>{
      const reservation=(await tx<{reserved_account_id:string|null;canonical_address:string;state:string}[]>`
        SELECT reserved_account_id,canonical_address,state FROM transfer_address_reservations WHERE transfer_id=${transferId} FOR UPDATE`)[0];
      if(!reservation?.reserved_account_id||reservation.canonical_address!==pending.destination_address||reservation.state!=="submitted")
        throw new Error("Managed destination address is not durably reserved");
      const existing=(await tx<{cose:Uint8Array}[]>`SELECT cose FROM address_bindings WHERE account_id=${reservation.reserved_account_id}
        AND canonical_address=${pending.destination_address} FOR UPDATE`)[0];
      if(existing){if(!same(existing.cose,pending.destination_binding_cose))throw new Error("Reserved address has another managed binding");return;}
      await tx`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
        VALUES(${randomUUID()},${reservation.reserved_account_id},${pending.destination_address},${manifest.did},${pending.destination_binding_cose},
          ${pending.destination_binding_digest},${new Date(binding.issued_at*1000)},${new Date(binding.expires_at*1000)},clock_timestamp(),clock_timestamp(),clock_timestamp())`;
    });
  }

  private async importGrants(tx:SQL,manifest:ManagedTransferManifest,identityKey:CryptoKey,evidence:PlcResolutionEvidence,now:Date) {
    for(const row of manifest.tables.grant_lineages)await insert(tx,"grant_lineages",row);
    for(const row of manifest.tables.grant_revisions)await insert(tx,"grant_revisions",row);
    for(const row of manifest.tables.grant_consent_evidence)await insert(tx,"grant_consent_evidence",row);
    for(const row of manifest.tables.grant_publications)await insert(tx,"grant_publications",row);
    for(const lineage of manifest.tables.grant_lineages) {
      if(lineage.local_role!=="grantor"||lineage.current_status!=="active")continue;
      const priorRow=manifest.tables.grant_revisions.find(row=>row.grant_id===lineage.grant_id&&row.revision===lineage.current_revision)!;
      const prior=inspectSignedPayload("hail.grant",bytes(priorRow.cose)).payload;
      const payload:HailGrant={...prior,revision:prior.revision+1,previous:bytes(priorRow.representation_digest),
        updated_at:Math.max(Math.floor(now.getTime()/1000),prior.updated_at+1),key_id:`${manifest.did}#hail-identity`};
      const cose=await signPayload("hail.grant",payload,createWebCryptoSigner(payload.key_id,identityKey)),digest=sha(cose);
      await tx`INSERT INTO grant_revisions(grant_id,revision,status,issued_at,updated_at,expires_at,previous_digest,scope_payload,
        consent_address_binding_sha256,consent_sender_profile_sha256,cose,representation_digest,signing_public_key,
        signing_plc_document,signing_plc_data,signing_plc_operation_log)
        VALUES(${payload.grant_id},${payload.revision},${payload.status},${payload.issued_at},${payload.updated_at},${payload.expires_at},${payload.previous},
          ${JSON.stringify(payload.scope)}::jsonb,${payload.consent_context.address_binding_hash.value},${payload.consent_context.sender_profile_hash.value},
          ${cose},${digest},${manifest.destinationIdentityPublicKey},${JSON.stringify(evidence.document)}::jsonb,
          ${JSON.stringify(evidence.data)}::jsonb,${JSON.stringify(evidence.log)}::jsonb)`;
      await tx`UPDATE grant_lineages SET current_revision=${payload.revision},current_digest=${digest},updated_at=${now} WHERE grant_id=${payload.grant_id}`;
      const predecessor=manifest.tables.grant_publications.find(row=>row.grant_id===lineage.grant_id&&row.revision===lineage.current_revision)!;
      await tx`INSERT INTO grant_publications(grant_id,revision,destination_service_base) VALUES(${payload.grant_id},${payload.revision},${predecessor.destination_service_base})`;
      await retainPublicGrantAuthority(tx,{localAccountId:manifest.accountId,localRole:"grantor",payload,representation:cose,digest,
        signingPublicKey:manifest.destinationIdentityPublicKey,signingPlcEvidence:evidence,expectedServiceBase:this.serviceBase});
    }
  }

  private async importEnvelopes(tx:SQL,manifest:ManagedTransferManifest) {
    const waiting=[...manifest.tables.sent_envelopes.map(row=>({table:"sent_envelopes",row})),
      ...manifest.tables.received_envelopes.map(row=>({table:"received_envelopes",row}))],sent=new Set<string>(),received=new Set<string>();
    while(waiting.length){let progress=false;for(let index=waiting.length-1;index>=0;index--){const entry=waiting[index]!,row=entry.row,
      dependency=`${row.recipient_did}\0${row.reply_to_message_id}`;
      if(row.authorization_type==="reply"&&!(entry.table==="sent_envelopes"?received:sent).has(dependency))continue;
      await insert(tx,entry.table,row);(entry.table==="sent_envelopes"?sent:received).add(`${row.sender_did}\0${row.message_id}`);
      waiting.splice(index,1);progress=true;}if(!progress)throw new Error("Managed imported replies contain an absent or cyclic original");}
  }

  private async refreshProfile(tx:SQL,manifest:ManagedTransferManifest,messagingKey:CryptoKey,evidence:PlcResolutionEvidence,now:Date) {
    const old=manifest.tables.sender_profiles.at(-1);if(!old)return;
    const prior=inspectSignedPayload("hail.sender-profile",bytes(old.cose)).payload;
    const payload:HailSenderProfile={...prior,revision:prior.revision+1,updated_at:Math.max(Math.floor(now.getTime()/1000),prior.updated_at+1),
      key_id:`${manifest.did}#hail-messaging`};
    const cose=await signPayload("hail.sender-profile",payload,createWebCryptoSigner(payload.key_id,messagingKey));
    await tx`INSERT INTO sender_profiles(id,account_id,did,revision,profile_payload,cose,representation_digest,signing_public_key,profile_updated_at)
      VALUES(${randomUUID()},${manifest.accountId},${manifest.did},${payload.revision},${payload}::jsonb,${cose},${sha(cose)},${manifest.destinationMessagingPublicKey},${payload.updated_at})`;
    await retainPublicSigningAuthority(tx,{actionType:"sender-profile",localAccountId:manifest.accountId,did:manifest.did,
      role:"hail-messaging",key:manifest.destinationMessagingPublicKey,serviceBase:this.serviceBase,representation:cose,evidence});
  }
}
