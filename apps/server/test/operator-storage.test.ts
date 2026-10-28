import {expect,it} from "vitest";
import {readStorage,storageCategory} from "../src/operator/storage.js";
import type {SQL} from "bun";

it.each([
  ['detached_bodies','content'],['verified_body_provenance','content'],['shared_content_blobs','content'],
  ['connection_message_targets','delivery'],['received_envelopes','delivery'],['sent_delivery_status','delivery'],
  ['account_passkeys','accounts'],['provider_operators','accounts'],['public_onboarding_drafts','accounts'],
  ['account_grant_approvals','connections'],['federated_connection_events','connections'],
  ['public_plc_shared_evidence','evidence'],['public_envelope_authority_evidence','evidence'],['connection_proof_signatures','evidence'],
  ['provider_migration_exports','migration'],['pending_migration_imports','migration'],
  ['connection_history_archives','migration'],['connection_transfer_commands','migration'],
  ['unrecognized_future_table','other'],
])('classifies %s as %s',(name,category)=>expect(storageCategory(name)).toBe(category));

it('keeps data, indexes and database remainder separate without double counting',async()=>{
  const sql=(async()=>[{database_bytes:1000,relations:[
    {name:'detached_bodies',table_bytes:300,index_bytes:100},
    {name:'verified_body_provenance',table_bytes:100,index_bytes:50},
    {name:'new_table',table_bytes:50,index_bytes:20},
  ]}]) as unknown as SQL;
  const result=await readStorage(sql);
  expect(result.applicationBytes).toBe(620);expect(result.indexBytes).toBe(170);
  expect(result.otherDatabaseBytes).toBe(380);
  expect(result.categories.find(c=>c.id==='content')).toMatchObject({tableBytes:400,indexBytes:150,totalBytes:550});
  expect(result.categories.find(c=>c.id==='other')!.totalBytes).toBe(70);
  expect(result.categories.find(c=>c.id==='migration')!.totalBytes).toBe(0);
});

it('keeps activity available when storage collection fails',async()=>{
  const {OperatorStatistics}=await import('../src/operator/stats.js');
  let calls=0;
  const sql=(async()=>{if(calls++)throw new Error('size permission denied');return [{totals:{sent:1},activity:[]}];}) as unknown as SQL;
  const result=await new OperatorStatistics(sql).read('day');
  expect(result.storage).toBeNull();expect(result.totals.sent).toBe(1);
});
