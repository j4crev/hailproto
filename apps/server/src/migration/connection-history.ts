import {createHash} from "node:crypto";
import {decodeBase64Url,decodeDeterministic,encodeDeterministic,inspectSignedPayload,type HailValue} from "@hailproto/codec";
import type {SQL} from "bun";
import {parseJsonWithoutDuplicateKeys} from "../discovery/strict-json.js";
import {canonicalizeHailServiceBase} from "../plc/resolver.js";

// Explicit projections: neither new database columns nor encrypted admission/share
// tokens may accidentally become part of a portable history checkpoint.
export const CONNECTION_HISTORY_COLUMNS={
  connection_invitations:"id account_id serving_generation did personal label request_id request_digest token_hash cose signing_key signing_evidence created_at expires_at revoked_at",
  account_connections:"id account_a account_b did_a did_b generation_a generation_b grant_id_a grant_id_b state created_at pending_until activated_at ended_at ended_by invitation_cose confirmation_cose grant_a_cose grant_b_cose evidence_a evidence_b consent_format",
  connection_approvals:"id account_id serving_generation action connection_id invitation_id request_digest intent_bytes actor_key peer_key actor_binding peer_binding expires_at result owner_payload federated_pair_id remote_bundle",
  federated_connection_pairs:"id account_id serving_generation local_did peer_did peer_address peer_service_base coordinator_service_base epoch state connection_id cutoff_at created_at updated_at",
  federated_connection_attempts:"id account_id pair_id direction bundle proof_digest admission_cose result_cose state expires_at next_attempt_at attempts created_at",
  federated_connection_events:"id account_id pair_id epoch state connection_id request_id proof_digest created_at",
  federated_connection_results:"id account_id pair_id action request_cose proof_digest event_id",
  federated_connection_tombstones:"account_id pair_id connection_id epoch created_at",
  federated_connection_disconnects:"id account_id pair_id connection_id epoch result_cose next_attempt_at attempts",
  federated_connection_outbox:"id account_id event_id ack_cose next_attempt_at attempts",
  federated_connection_signatures:"digest account_id cose authority",
  connection_message_batches:"account_id id sender_did serving_generation body_bytes manifest request_digest created_at expires_at cancelled_at sealed",
  connection_message_targets:"account_id publication_id connection_id connection_epoch recipient_did message_id state attempts next_attempt_at",
  public_plc_resolution_evidence:"evidence_digest did operation_cid verified_at bundle_bytes",
} as const;
type Table=keyof typeof CONNECTION_HISTORY_COLUMNS;
type Row=Record<string,unknown>;
export interface ConnectionHistoryOwner {accountId:string;did:string;sourceGeneration:number;sourceServiceBase:string;}
export interface ConnectionHistory extends ConnectionHistoryOwner {
  type:"hail.connection-history";version:1;capturedAt:string;
  // Source observations only. These rows are never inserted into live invitation
  // or approval tables; committed cutover must invalidate every source share code.
  sharePolicy:"invalidate-at-cutover";
  tables:Record<Table,Row[]>;
}
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DID=/^did:plc:[a-z2-7]{24}$/;
const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
const same=(a:Uint8Array,b:Uint8Array)=>Buffer.from(a).equals(Buffer.from(b));
const fail=(message:string):never=>{throw new Error("Connection history "+message);};
function bytes(value:unknown,max=100000):Uint8Array {
  if(typeof value!=="string"||!/^\\x(?:[0-9a-f]{2})+$/.test(value)||value.length>2+max*2)return fail("contains invalid byte evidence");
  return new Uint8Array(Buffer.from(value.slice(2),"hex"));
}
function integer(value:unknown,min=0):number {
  if(typeof value!=="number"&&!(typeof value==="string"&&/^(0|[1-9][0-9]*)$/.test(value)))return fail("contains an invalid integer");
  const n=Number(value);if(!Number.isSafeInteger(n)||n<min)return fail("contains an invalid integer");return n;
}
function unique(rows:Row[],key:(row:Row)=>unknown):Map<unknown,Row> {
  const result=new Map<unknown,Row>();
  for(const row of rows){const id=key(row);if(result.has(id))return fail("duplicates retained identity");result.set(id,row);}
  return result;
}
function evidenceRows(tables:ConnectionHistory["tables"]):unknown[] {
  return [...tables.connection_invitations.map(r=>r.signing_evidence),
    ...tables.account_connections.flatMap(r=>[r.evidence_a,r.evidence_b]),
    ...tables.federated_connection_signatures.map(r=>r.authority)].filter(v=>v!==null);
}
function authorityDigest(value:unknown):string|undefined {
  const evidence=(typeof value==="string"?parseJsonWithoutDuplicateKeys(value):value) as {verification?:{digest?:unknown}};
  if(!evidence||typeof evidence!=="object")return fail("lacks retained signing evidence");
  if(evidence.verification===undefined)return;
  const digest=evidence.verification?.digest;
  if(typeof digest!=="string"||decodeBase64Url(digest).length!==32)return fail("has invalid authority reference");
  return "\\x"+Buffer.from(decodeBase64Url(digest)).toString("hex");
}

// Structural/integrity validation, NOT historical signature verification or
// admission to live messaging. The enclosing transfer authenticates these bytes;
// import/handover must separately validate historical authority before activation.
export function validateConnectionHistory(input:Uint8Array,owner:ConnectionHistoryOwner):ConnectionHistory {
  if(!input.length||input.length>67_108_864)return fail("exceeds its size limit");
  const history=parseJsonWithoutDuplicateKeys(new TextDecoder("utf-8",{fatal:true}).decode(input)) as ConnectionHistory;
  const fields=["type","version","accountId","did","sourceGeneration","sourceServiceBase","capturedAt","sharePolicy","tables"];
  if(!history||typeof history!=="object"||Array.isArray(history)||Object.keys(history).length!==fields.length||fields.some(k=>!Object.hasOwn(history,k))||
    history.type!=="hail.connection-history"||history.version!==1||history.sharePolicy!=="invalidate-at-cutover"||
    !UUID.test(history.accountId)||!DID.test(history.did)||!Number.isSafeInteger(history.sourceGeneration)||history.sourceGeneration<1||
    history.accountId!==owner.accountId||history.did!==owner.did||history.sourceGeneration!==owner.sourceGeneration||history.sourceServiceBase!==owner.sourceServiceBase||
    canonicalizeHailServiceBase(history.sourceServiceBase)!==history.sourceServiceBase||typeof history.capturedAt!=="string"||!Number.isFinite(Date.parse(history.capturedAt))||
    !history.tables||typeof history.tables!=="object"||Array.isArray(history.tables)||Object.keys(history.tables).length!==Object.keys(CONNECTION_HISTORY_COLUMNS).length)return fail("has invalid ownership or serialization domain");
  const tables=history.tables;
  for(const table of Object.keys(CONNECTION_HISTORY_COLUMNS) as Table[]){
    const columns=CONNECTION_HISTORY_COLUMNS[table].split(" ");
    if(!Array.isArray(tables[table]))return fail("is missing "+table);
    for(const row of tables[table]){
      if(!row||typeof row!=="object"||Array.isArray(row)||Object.keys(row).length!==columns.length||columns.some(k=>!Object.hasOwn(row,k)))return fail("has unexpected fields in "+table);
      if(table!=="account_connections"&&table!=="public_plc_resolution_evidence"&&row.account_id!==owner.accountId)return fail("contains another account");
      if("serving_generation" in row&&integer(row.serving_generation,1)>owner.sourceGeneration)return fail("contains a future generation");
      if("id" in row&&(typeof row.id!=="string"||!UUID.test(row.id)))return fail("contains invalid row identity");
    }
    if(table!=="connection_message_targets"&&table!=="federated_connection_tombstones")unique(tables[table],r=>r.id??r.digest??r.evidence_digest);
  }
  const invitations=unique(tables.connection_invitations,r=>r.id);
  for(const row of invitations.values()){
    const p=inspectSignedPayload("hail.connection-invitation",bytes(row.cose,16384)).payload;
    if(row.did!==owner.did||p.from!==owner.did||p.invitation_id!==row.id||!same(p.token_hash.value,bytes(row.token_hash,32))||
      p.expires_at!==(row.expires_at===null?null:integer(row.expires_at)))return fail("invitation differs from signed consent");
  }
  const native=unique(tables.account_connections,r=>r.id);
  for(const row of native.values()){
    const side=row.account_a===owner.accountId?"a":row.account_b===owner.accountId?"b":null;
    if(!side||row["did_"+side]!==owner.did||!DID.test(String(row.did_a))||!DID.test(String(row.did_b))||String(row.did_a)>=String(row.did_b)||
      row.account_a===row.account_b||integer(row["generation_"+side],1)>owner.sourceGeneration||!["pending","active","disconnected","expired"].includes(String(row.state)))return fail("native pair ownership differs");
    if(row.state==="pending"&&Date.parse(String(row.pending_until))>Date.parse(history.capturedAt))return fail("has unfinished native consent");
    if(row.state==="active"||row.state==="disconnected"){
      const invitation=inspectSignedPayload("hail.connection-invitation",bytes(row.invitation_cose,16384)).payload;
      const confirmation=inspectSignedPayload("hail.connection-confirmation",bytes(row.confirmation_cose,16384)).payload;
      if(![row.did_a,row.did_b].includes(invitation.from)||![row.did_a,row.did_b].includes(confirmation.from)||invitation.from===confirmation.from||
        confirmation.to!==invitation.from||confirmation.invitation_id!==invitation.invitation_id||!same(confirmation.invitation_hash.value,hash(bytes(row.invitation_cose,16384))))return fail("native consent linkage differs");
      if(row.consent_format==="grants-v1")for(const side of ["a","b"]){
        const grant=inspectSignedPayload("hail.connection-grant",bytes(row["grant_"+side+"_cose"],16384)).payload;
        if(grant.connection_id!==row.id||grant.grant_id!==row["grant_id_"+side]||grant.grantor!==row["did_"+side]||
          grant.grantee!==row["did_"+(side==="a"?"b":"a")]||!same(grant.consent_context.invitation_hash.value,hash(bytes(row.invitation_cose,16384)))||
          !same(grant.consent_context.confirmation_hash.value,hash(bytes(row.confirmation_cose,16384))))return fail("native Grant linkage differs");
      }else if(row.consent_format!=="joint-v1"||row.grant_a_cose!==null||row.grant_b_cose!==null)return fail("has invalid native consent format");
    }
    if(row.state==="disconnected"&&(!row.ended_at||![row.account_a,row.account_b].includes(row.ended_by)))return fail("lost native disconnect history");
  }
  const pairs=unique(tables.federated_connection_pairs,r=>r.id);
  unique(tables.federated_connection_pairs,r=>r.peer_did);
  for(const row of pairs.values()){
    const epoch=integer(row.epoch);
    if(row.local_did!==owner.did||!DID.test(String(row.peer_did))||row.peer_did===owner.did||
      canonicalizeHailServiceBase(String(row.peer_service_base))!==row.peer_service_base||
      row.coordinator_service_base!==(owner.did<String(row.peer_did)?owner.sourceServiceBase:row.peer_service_base)||
      !(row.state==="empty"&&epoch===0&&row.connection_id===null||["active","disconnected"].includes(String(row.state))&&epoch>0&&UUID.test(String(row.connection_id))))return fail("has invalid federated pair state");
  }
  for(const table of ["federated_connection_attempts","federated_connection_events","federated_connection_results","federated_connection_tombstones","federated_connection_disconnects"] as const)
    for(const row of tables[table])if(!pairs.has(row.pair_id))return fail("references an absent pair");
  const events=unique(tables.federated_connection_events,r=>r.id);
  unique(tables.federated_connection_events,r=>r.pair_id+":"+r.epoch);
  for(const row of events.values()){
    const pair=pairs.get(row.pair_id)!;
    if(String(pair.local_did)>String(pair.peer_did)||integer(row.epoch,1)>integer(pair.epoch)||!["active","disconnected"].includes(String(row.state))||!UUID.test(String(row.connection_id)))return fail("has invalid coordinator event");
  }
  for(const pair of pairs.values())if(owner.did<String(pair.peer_did)&&pair.state!=="empty"&&
    ![...events.values()].some(e=>e.pair_id===pair.id&&integer(e.epoch)===integer(pair.epoch)&&e.state===pair.state&&e.connection_id===pair.connection_id))return fail("lost current coordinator event");
  for(const row of tables.federated_connection_results){
    const event=events.get(row.event_id),pair=pairs.get(row.pair_id)!;
    const control=inspectSignedPayload("hail.connection-control",bytes(row.request_cose,16384)).payload;
    if(!event||event.pair_id!==row.pair_id||control.request_id!==row.id||control.operation!==row.action||
      ![pair.local_did,pair.peer_did].includes(control.from)||![pair.local_did,pair.peer_did].includes(control.to)||control.from===control.to||
      !same(control.proof_hash.value,bytes(row.proof_digest,32)))return fail("result lost its causal command");
  }
  for(const row of tables.federated_connection_attempts){
    if(row.state==="pending"||row.direction==="admitted"&&!row.result_cose&&
      !tables.federated_connection_results.some(r=>r.id===row.id)&&Date.parse(String(row.expires_at))>Date.parse(history.capturedAt))return fail("has unfinished admission work");
    if(!same(hash(bytes(row.bundle)),bytes(row.proof_digest,32)))return fail("proof bundle digest differs");
    const bundle=decodeDeterministic(bytes(row.bundle)) as Record<string,HailValue>,pair=pairs.get(row.pair_id)!;
    if(!bundle||!(bundle.invitation instanceof Uint8Array)||!(bundle.confirmation instanceof Uint8Array))return fail("has invalid proof bundle");
    const invitation=inspectSignedPayload("hail.connection-invitation",bundle.invitation).payload;
    const confirmation=inspectSignedPayload("hail.connection-confirmation",bundle.confirmation).payload;
    if(confirmation.confirmation_id!==row.id||confirmation.to!==invitation.from||confirmation.from===invitation.from||
      ![pair.local_did,pair.peer_did].includes(invitation.from)||![pair.local_did,pair.peer_did].includes(confirmation.from)||
      confirmation.invitation_id!==invitation.invitation_id||!same(confirmation.invitation_hash.value,hash(bundle.invitation)))return fail("federated consent linkage differs");
  }
  unique(tables.federated_connection_tombstones,r=>r.pair_id+":"+r.connection_id);
  for(const row of tables.federated_connection_tombstones){
    const pair=pairs.get(row.pair_id)!;
    if(!UUID.test(String(row.connection_id))||integer(row.epoch)>integer(pair.epoch)||pair.state==="active"&&pair.connection_id===row.connection_id)return fail("has inconsistent terminal history");
  }
  for(const pair of pairs.values())if(pair.state==="disconnected"&&!tables.federated_connection_tombstones.some(r=>r.pair_id===pair.id&&r.connection_id===pair.connection_id))return fail("lost terminal tombstone");
  for(const row of tables.federated_connection_disconnects)if(row.result_cose===null)return fail("has unfinished disconnect work");
  for(const row of tables.federated_connection_outbox)if(row.ack_cose===null||!events.has(row.event_id))return fail("has unfinished or orphaned replication work");
  for(const row of tables.connection_approvals){
    const intent=decodeDeterministic(bytes(row.intent_bytes)) as Record<string,HailValue>;
    if(!intent||typeof intent!=="object"||"token" in intent)return fail("approval contains admission secrets");
    if(row.result===null&&Date.parse(String(row.expires_at))>Date.parse(history.capturedAt))return fail("has unfinished passkey consent");
    if(row.connection_id!==null&&!native.has(row.connection_id)||row.invitation_id!==null&&!invitations.has(row.invitation_id)&&row.action!=="connect"||
      row.federated_pair_id!==null&&!pairs.has(row.federated_pair_id))return fail("approval has absent history");
  }
  const batches=unique(tables.connection_message_batches,r=>r.id);
  unique(tables.connection_message_targets,r=>r.publication_id+":"+r.recipient_did);
  unique(tables.connection_message_targets,r=>r.message_id);
  for(const row of batches.values()){
    if(row.sender_did!==owner.did||row.sealed!==true)return fail("has unsealed or foreign message batch");
    const audience=decodeDeterministic(bytes(row.manifest,65536)) as unknown as {connectionId:string;recipientDid:string;epoch:number;address:string}[];
    const targets=tables.connection_message_targets.filter(t=>t.publication_id===row.id);
    if(!Array.isArray(audience)||!audience.length||audience.length>100||audience.length!==targets.length||
      new Set(audience.map(t=>t.recipientDid)).size!==audience.length||audience.some(t=>!targets.some(r=>r.connection_id===t.connectionId&&r.recipient_did===t.recipientDid&&integer(r.connection_epoch,1)===t.epoch))||
      !same(hash(encodeDeterministic({connections:audience.map(t=>t.connectionId).sort(),body:bytes(row.body_bytes,262144)})),bytes(row.request_digest,32)))return fail("message audience or body differs from retained intent");
  }
  for(const row of tables.connection_message_targets)if(!batches.has(row.publication_id)||!["submitted","blocked","cancelled","expired","indeterminate"].includes(String(row.state))||
    !DID.test(String(row.recipient_did))||!UUID.test(String(row.connection_id))||!UUID.test(String(row.message_id))||integer(row.connection_epoch,1)<1)return fail("has unfinished or orphaned message work");
  for(const row of tables.federated_connection_signatures)if(!same(hash(bytes(row.cose,16384)),bytes(row.digest,32))||
    inspectSignedPayload("hail.connection-control",bytes(row.cose,16384)).payload.from!==owner.did)return fail("signed control digest or owner differs");
  const references=new Set(evidenceRows(tables).map(authorityDigest).filter(v=>v!==undefined));
  const authority=unique(tables.public_plc_resolution_evidence,r=>r.evidence_digest);
  if(references.size!==authority.size||[...references].some(d=>!authority.has(d)))return fail("lost historical public authority evidence");
  for(const row of authority.values())if(!same(hash(bytes(row.bundle_bytes,1_048_576)),bytes(row.evidence_digest,32)))return fail("authority evidence digest differs");
  return history;
}

export function connectionHistoryDigest(history:ConnectionHistory):Uint8Array {
  return hash(encodeDeterministic(history as unknown as HailValue));
}

// Caller supplies the existing export's fenced/drained transaction. No mutation,
// revocation, generation advance or network request occurs while collecting history.
export async function collectConnectionHistory(tx:SQL,owner:ConnectionHistoryOwner,capturedAt:string):Promise<ConnectionHistory> {
  const account=(await tx<{did:string;generation:number|string}[]>`SELECT a.did,g.generation FROM provider_accounts a
    JOIN account_serving_generations g ON g.account_id=a.id WHERE a.id=${owner.accountId}`)[0];
  if(account?.did!==owner.did||Number(account.generation)!==owner.sourceGeneration)return fail("source ownership changed before capture");
  const tables={} as ConnectionHistory["tables"];
  for(const table of Object.keys(CONNECTION_HISTORY_COLUMNS) as Table[]){
    if(table==="public_plc_resolution_evidence")continue;
    const columns=CONNECTION_HISTORY_COLUMNS[table].split(" ");
    const projection=columns.map(c=>`'${c}',t."${c}"`).join(",");
    // Identifiers/projections are internal constants, never manifest input.
    const where=table==="account_connections"?"$1::uuid IN(t.account_a,t.account_b)":"t.account_id=$1::uuid";
    const rows=await tx.unsafe<{row:Row}[]>(`SELECT jsonb_build_object(${projection}) AS row FROM "${table}" t WHERE ${where} ORDER BY ${columns.map(c=>`t."${c}"`).filter(c=>c.endsWith('"id"')||c.endsWith('"connection_id"')||c.endsWith('"recipient_did"')||c.endsWith('"digest"')).join(",")}`,[owner.accountId]);
    tables[table]=rows.map(r=>r.row);
  }
  tables.public_plc_resolution_evidence=[];
  for(const digest of [...new Set(evidenceRows(tables).map(authorityDigest).filter(v=>v!==undefined))].sort()){
    const rows=await tx<{row:Row}[]>`SELECT jsonb_build_object('evidence_digest',evidence_digest,'did',did,'operation_cid',operation_cid,
      'verified_at',verified_at,'bundle_bytes',bundle_bytes) AS row FROM public_plc_resolution_evidence WHERE evidence_digest=${bytes(digest,32)}`;
    if(!rows[0])return fail("lost historical public authority evidence");tables.public_plc_resolution_evidence.push(rows[0].row);
  }
  const history:ConnectionHistory={type:"hail.connection-history",version:1,...owner,capturedAt,sharePolicy:"invalidate-at-cutover",tables};
  return validateConnectionHistory(new TextEncoder().encode(JSON.stringify(history)),owner);
}
