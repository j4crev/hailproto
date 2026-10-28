import type {SQL} from "bun";

export const storageCategories = [
  {id:"content",label:"Message content"},
  {id:"delivery",label:"Message delivery & metadata"},
  {id:"accounts",label:"Accounts & security"},
  {id:"connections",label:"Connections & permissions"},
  {id:"evidence",label:"Verification evidence"},
  {id:"migration",label:"Migration & retained history"},
  {id:"other",label:"Other application data"},
] as const;
type CategoryId=typeof storageCategories[number]["id"];
export type StorageStats={databaseBytes:number;applicationBytes:number;indexBytes:number;otherDatabaseBytes:number;
  categories:{id:CategoryId;label:string;tableBytes:number;indexBytes:number;totalBytes:number}[]};

// Classification is by table responsibility, not by inspecting private content.
// Unknown tables remain visible in "other" rather than disappearing from totals.
export function storageCategory(name:string):CategoryId{
  if(["detached_bodies","verified_body_provenance","shared_content_blobs"].includes(name))return "content";
  if(["sent_envelopes","received_envelopes","delivered_messages","body_authorizations","delivery_work",
    "delivery_status_payloads","delivery_status_wrappers","terminal_status_publications","sent_delivery_status",
    "reply_capabilities","account_message_preferences","account_publications","publication_targets",
    "connection_message_batches","connection_message_targets"].includes(name))return "delivery";
  if(/migration|transfer|custody|cutover|^provider_retired_|^connection_(history_archives|import_handovers|handover_)/.test(name))return "migration";
  if(/^public_.*_(evidence|selection)$|^plc_operation_evidence$|^connection_proof_signatures$/.test(name))return "evidence";
  if(/^grant_|^collocated_grant_|^connection_|^federated_connection_|^account_(connections|grant_approvals)$/.test(name))return "connections";
  if(/^account_|^provider_(accounts|operators|signup_invitations|reserved_names|role_claims)$|^(public|private_poc)_onboarding_|^address_bindings$|^(verified_)?sender_profiles$/.test(name))return "accounts";
  return "other";
}

export async function readStorage(sql:SQL):Promise<StorageStats>{
  const [result]=await sql<{database_bytes:number;relations:{name:string;table_bytes:number;index_bytes:number}[]}[]>`
    SELECT pg_database_size(current_database())::float8 AS database_bytes,
      coalesce((SELECT json_agg(json_build_object('name',c.relname,
        'table_bytes',pg_table_size(c.oid)::float8,'index_bytes',pg_indexes_size(c.oid)::float8))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','m') AND c.relpersistence<>'t'), '[]'::json) AS relations`;
  const categories=storageCategories.map(category=>({...category,tableBytes:0,indexBytes:0,totalBytes:0}));
  for(const relation of result!.relations){
    const category=categories.find(item=>item.id===storageCategory(relation.name))!;
    category.tableBytes+=relation.table_bytes;category.indexBytes+=relation.index_bytes;
    category.totalBytes+=relation.table_bytes+relation.index_bytes;
  }
  const applicationBytes=categories.reduce((total,item)=>total+item.totalBytes,0);
  return {databaseBytes:result!.database_bytes,applicationBytes,
    indexBytes:categories.reduce((total,item)=>total+item.indexBytes,0),
    // Files can grow during measurement; this is an approximate remainder, not bloat.
    otherDatabaseBytes:Math.max(0,result!.database_bytes-applicationBytes),categories};
}
