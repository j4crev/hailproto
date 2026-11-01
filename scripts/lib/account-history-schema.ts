import type {SQL} from 'bun';
import {TRANSFER_TABLES,TRANSFER_AUTHORITY_TABLES} from '../../apps/server/src/migration/transfer.js';
import {MANAGED_TRANSFER_TABLES} from '../../apps/server/src/migration/managed-snapshot.js';
import {CONNECTION_HISTORY_COLUMNS} from '../../apps/server/src/migration/connection-history.js';
import {CONVERSATION_COLUMNS} from '../../apps/server/src/migration/conversation-history.js';

type Schema=Record<string,any>;
const object=(properties:Record<string,Schema>):Schema=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const ref=(name:string)=>({$ref:'#/definitions/'+name});
const integer={type:'integer',minimum:-9007199254740991,maximum:9007199254740991};
const text={type:'string'};
const uuid={type:'string',pattern:'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'};
const did={type:'string',pattern:'^did:plc:[a-z2-7]{24}$'};
const timestamp={type:'string',format:'date-time'};
const digest={type:'string',pattern:'^[A-Za-z0-9_-]{43}$'};
const common={accountId:uuid,did,sourceGeneration:{...integer,minimum:1},sourceServiceBase:text,capturedAt:timestamp};

/** Read only a fully migrated disposable database. This is a reference-storage mapping,
 * not a runtime dependency of importers or of the published schema. */
export async function accountHistorySchema(sql:SQL):Promise<Schema>{
  const columns=await sql<{table_name:string;column_name:string;udt_name:string;is_nullable:string}[]>`
    SELECT table_name,column_name,udt_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' ORDER BY table_name,ordinal_position`;
  const keys=await sql<{table_name:string;columns:string[]}[]>`
    SELECT c.relname AS table_name,array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(num,ord)
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num
    WHERE p.contype='p' AND n.nspname='public' GROUP BY c.relname ORDER BY c.relname`;
  const constraints=await sql<{table_name:string;definition:string}[]>`
    SELECT c.relname AS table_name,pg_get_constraintdef(p.oid) AS definition
    FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE p.contype='c' AND n.nspname='public' ORDER BY c.relname,p.conname`;
  const definitions:Record<string,Schema>={
    'json-value':{anyOf:[{type:'null'},{type:'boolean'},integer,text,{type:'array',items:ref('json-value')},{type:'object',additionalProperties:ref('json-value')}]},
  };
  const aliases:Record<string,string>={verified_body_provenance:'verified_body_contents',public_plc_resolution_evidence:'public_plc_resolution_contents'};
  function columnSchema(column:typeof columns[number],view:boolean):Schema{
    let value:Schema;
    switch(column.udt_name){
      case 'uuid':value=uuid;break;
      case 'timestamptz':value=timestamp;break;
      case 'bytea':value={type:'string',pattern:'^\\\\x(?:[0-9a-f]{2})*$'};break;
      case 'int2':case 'int4':case 'int8':value=integer;break;
      case 'bool':value={type:'boolean'};break;
      case 'jsonb':value=ref('json-value');break;
      case 'text':case 'varchar':value=text;break;
      case '_text':value={type:'array',items:text};break;
      default:throw Error('Unspecified history column type '+column.table_name+'.'+column.column_name+': '+column.udt_name);
    }
    // Translate only complete, single-column predicates. Compound authority and
    // relational conditions belong to the normative semantic validation steps.
    const table=column.table_name==='public_plc_resolution_contents'?'public_plc_resolution_evidence':column.table_name==='verified_body_contents'?'verified_body_provenance':column.table_name;
    value={...value};
    for(const {definition} of constraints.filter(c=>c.table_name===table)){
      let m=definition.match(/^CHECK \(\((\w+) = ANY \(ARRAY\[(.*)\]\)\)\)$/);
      if(m&&m[1]===column.column_name)value.enum=[...m[2]!.matchAll(/'([^']*)'::text/g)].map(v=>v[1]);
      m=definition.match(/^CHECK \(\((\w+) (>=|>|<=|<) (-?\d+)\)\)$/);
      if(m&&m[1]===column.column_name){const n=Number(m[3]);if(m[2]==='>'||m[2]==='>=')value.minimum=n+(m[2]==='>'?1:0);else value.maximum=n-(m[2]==='<'?1:0);}
      m=definition.match(/^CHECK \(\((\w+) ~ '([^']*)'::text\)\)$/);
      if(m&&m[1]===column.column_name)value.pattern=m[2];
      m=definition.match(/^CHECK \(\(octet_length\((\w+)\) = (\d+)\)\)$/);
      if(m&&m[1]===column.column_name){value.minLength=2+2*Number(m[2]);value.maxLength=value.minLength;}
    }
    if(column.udt_name==='bytea'&&/(?:digest|hash|sha256)$/.test(column.column_name)){
      value.minLength=66;value.maxLength=66;
    }
    return column.is_nullable==='YES'&&!view?{anyOf:[value,{type:'null'}]}:value;
  }
  function records(domain:string,tables:readonly string[],projections?:Record<string,string>){
    const properties:Record<string,Schema>={};
    for(const name of tables){
      const source=aliases[name]??name;
      let selected=columns.filter(c=>c.table_name===source);
      if(projections){const wanted=projections[name]!.split(' ');selected=wanted.map(key=>{
        const c=selected.find(c=>c.column_name===key);if(!c)throw Error('Missing projection '+name+'.'+key);return c;
      });}else{
        const excluded=name==='provider_accounts'?['address_released_at','closed_at']:name==='account_keys'
          ?['encrypted_private_key','encryption_nonce','kek_id',...(domain==='managed'?['encryption_version']:[])]:
          domain==='managed'&&['grant_publications','delivery_work','terminal_status_publications'].includes(name)?['lease_token','lease_expires_at']:[];
        selected=selected.filter(c=>!excluded.includes(c.column_name));
      }
      if(!selected.length)throw Error('Missing record '+name);
      const definition=domain+'-'+name;
      const key=keys.find(k=>k.table_name===name)?.columns??[];
      const fields=Object.fromEntries(selected.map(c=>[c.column_name,columnSchema(c,source!==name)]));
      if(name==='provider_accounts'){fields.onboarding_state={const:'active'};fields.activation_verification_mode={const:'public'};}
      if(name==='account_keys')fields.role={enum:domain==='portable'?['plc-rotation','hail-messaging']:['plc-rotation','hail-identity','hail-messaging']};
      if(name==='conversation_revival_targets')fields.outcome={enum:['renewed','active','left','denied','expired']};
      if(name==='connection_message_targets')fields.state={enum:['submitted','blocked','cancelled','expired','indeterminate']};
      if(name==='connection_message_batches')fields.sealed={const:true};
      if(name==='conversation_descriptors')fields.participants={type:'array',items:did,minItems:3,maxItems:101};
      definitions[definition]={...object(fields),
        description:`${name} logical records in the ${domain} history domain. See account-history.md for selection and semantic validation.`,
        'x-reference-storage':source,'x-record-key':key.filter(k=>selected.some(c=>c.column_name===k))};
      properties[name]={type:'array',items:ref(definition)};
    }
    return object(properties);
  }
  definitions['connection-history']={...object({type:{const:'hail.connection-history'},version:{const:3},...common,sharePolicy:{const:'invalidate-at-cutover'},
    tables:records('connections',Object.keys(CONNECTION_HISTORY_COLUMNS),CONNECTION_HISTORY_COLUMNS)})};
  definitions['conversation-history']={...object({type:{const:'hail.conversation-history'},version:{const:1},...common,
    tables:records('conversations',Object.keys(CONVERSATION_COLUMNS),CONVERSATION_COLUMNS)})};
  for(const [domain,version,tables] of [['portable',7,[...TRANSFER_TABLES,...TRANSFER_AUTHORITY_TABLES]],['managed',8,MANAGED_TRANSFER_TABLES]] as const){
    definitions[domain]=object({version:{const:version},transferId:uuid,...common,destinationServiceBase:text,
      destinationRotationPublicKey:text,destinationMessagingPublicKey:text,custodyProfile:{const:domain},
      ...(domain==='managed'?{ownerRecoveryPublicKey:text,sourceIdentityPublicKey:text,destinationIdentityPublicKey:text,historyCheckpointDigest:digest}:{}),
      connections:ref('connection-history'),connectionCheckpointDigest:digest,conversations:ref('conversation-history'),conversationCheckpointDigest:digest,
      tables:records(domain,tables)});
  }
  return {$schema:'http://json-schema.org/draft-07/schema#',$id:'https://hailproto.com/schemas/account-history-v7-v8.json',
    title:'Hail current account history: portable v7 / managed v8',
    description:'Storage-independent logical record contract for the current wire manifests. All records and fields are closed. Cross-record authority and consistency requirements are normative in account-history.md. The x-reference-storage annotations are informative only.',
    oneOf:[ref('portable'),ref('managed')],definitions};
}
