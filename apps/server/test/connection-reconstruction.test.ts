import {createHash,randomUUID} from 'node:crypto';
import {encodeDeterministic} from '@hailproto/codec';
import type {SQL} from 'bun';
import {expect,it} from 'vitest';
import {PLC_READ_EVIDENCE_POLICY_VERSION} from '../src/identity/managed-profile.js';
import {CONNECTION_HISTORY_COLUMNS,type ConnectionHistory} from '../src/migration/connection-history.js';
import {reconstructConnections} from '../src/migration/connection-reconstruction.js';

it('restores required public-evidence metadata without changing checkpoint bytes',async()=>{
  // Projection-only unit check: caller-side cryptographic authority verification
  // has separate real-PLC-chain tests. A closed checkpoint intentionally carries
  // signed evidence, not database-specific record/policy columns.
  const accountId=randomUUID(),transferId=randomUUID(),did='did:plc:'+'a'.repeat(24),
    bundle=encodeDeterministic({type:'hail.public-plc-resolution',version:1,policy:'strict-public-v1'}),
    evidence={evidence_digest:'\\x'+createHash('sha256').update(bundle).digest('hex'),did,operation_cid:'fixture-cid',
      verified_at:'2026-10-26T00:00:00.000Z',bundle_bytes:'\\x'+Buffer.from(bundle).toString('hex')},
    history:ConnectionHistory={type:'hail.connection-history',version:3,accountId,did,sourceGeneration:1,sourceServiceBase:'https://source.example.com/hail',
      capturedAt:'2026-10-26T00:00:00.000Z',sharePolicy:'invalidate-at-cutover',tables:Object.fromEntries(Object.keys(CONNECTION_HISTORY_COLUMNS).map(name=>[name,[] as Record<string,unknown>[]])) as ConnectionHistory['tables']};
  history.tables.public_plc_resolution_evidence.push(evidence);
  let restored:Record<string,unknown>|undefined;
  const sql=Object.assign(async(parts:TemplateStringsArray)=>{
    const query=parts.join('?');
    if(query.includes('FROM provider_accounts a JOIN account_serving_generations'))return [{did,generation:1}];
    return [];
  },{unsafe:async(query:string,values:unknown[])=>{
    if(query.startsWith('INSERT INTO "public_plc_resolution_evidence"'))restored=JSON.parse(String(values[0]));
    return [{inserted:true}];
  }}) as unknown as SQL;
  const manifest={accountId,transferId,did,custodyProfile:'portable',destinationServiceBase:'https://target.example.com/hail',connections:history} as Parameters<typeof reconstructConnections>[1];
  await reconstructConnections(sql,manifest,1);
  expect(restored).toEqual({...evidence,record_version:1,read_evidence_policy_version:PLC_READ_EVIDENCE_POLICY_VERSION});
});
