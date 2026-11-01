import Ajv from 'ajv';
import {base58btc} from 'multiformats/bases/base58';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {ed25519PublicKeyFromDidKey} from '../../src/identity/did-key.js';
import {validateTransferManifest,transferSnapshotSignatureInput} from '../../src/migration/transfer.js';
import {validateManagedTransferManifest} from '../../src/migration/managed-snapshot.js';
const schema=JSON.parse(await readFile(new URL('../../../../spec/schemas/account-history-v7-v8.json',import.meta.url),'utf8'));
const validate=new Ajv({allErrors:true}).compile(schema);
export function validateHistorySchema(value:unknown):void{
  if(!validate(value))throw Error('History schema: '+JSON.stringify(validate.errors));
}
/** Fixtures can only be captured from these synthetic integration tests, never from a user account. */
export async function assertExportConformance(snapshot:{bytes:Uint8Array;digest:Uint8Array;signature:Uint8Array;sourceMessagingPublicKey:string},kind:'portable'|'managed'){
  if(!Buffer.from(snapshot.digest).equals(createHash("sha256").update(snapshot.bytes).digest()))throw Error("Snapshot byte digest mismatch");
  const manifest=JSON.parse(new TextDecoder().decode(snapshot.bytes));
  validateHistorySchema(manifest);
  (kind==='portable'?validateTransferManifest:validateManagedTransferManifest)(snapshot.bytes);
  const key=await ed25519PublicKeyFromDidKey(snapshot.sourceMessagingPublicKey);
  if(!await crypto.subtle.verify('Ed25519',key,Uint8Array.from(snapshot.signature),transferSnapshotSignatureInput(snapshot.digest,manifest.version)))throw Error('Snapshot signature mismatch');
  if(process.env.HAIL_WRITE_HISTORY_VECTORS==='1'){
    const fixture={id:kind+'-history',source:'Synthetic '+kind+' migration integration test; PUBLIC TEST MATERIAL ONLY',
      publicKeyHex:Buffer.from(base58btc.decode(snapshot.sourceMessagingPublicKey.slice(8)).slice(2)).toString('hex'),
      sourceMessagingPublicKey:snapshot.sourceMessagingPublicKey,
      manifestBase64:Buffer.from(snapshot.bytes).toString('base64url'),
      digestHex:Buffer.from(snapshot.digest).toString('hex'),signatureHex:Buffer.from(snapshot.signature).toString('hex'),
      jsonWhitespaceMutationDigestHex:createHash('sha256').update(Buffer.concat([Buffer.from(snapshot.bytes),Buffer.from('\n')])).digest('hex')};
    await writeFile(new URL('../../../../spec/vectors/'+kind+'-history.json',import.meta.url),JSON.stringify(fixture,null,2)+'\n');
  }
}

export async function assertCheckpointConformance(history:any,id:string){
  const name=history.type==='hail.connection-history'?'connection-history':'conversation-history';
  const check=new Ajv({allErrors:true}).compile({$ref:'#/definitions/'+name,definitions:schema.definitions});
  if(!check(history))throw Error('Checkpoint schema: '+JSON.stringify(check.errors));
  if(process.env.HAIL_WRITE_HISTORY_VECTORS==='1'){
    const {connectionHistoryDigest}=await import('../../src/migration/connection-history.js');
    const {conversationHistoryDigest}=await import('../../src/migration/conversation-history.js');
    const digest=history.type==='hail.connection-history'?connectionHistoryDigest(history):conversationHistoryDigest(history);
    await writeFile(new URL('../../../../spec/vectors/'+id+'.json',import.meta.url),JSON.stringify({id,
      source:'Synthetic shared conversation integration: actual collector and reconstruction, PUBLIC TEST MATERIAL ONLY',
      history,digestHex:Buffer.from(digest).toString('hex')},null,2)+'\n');
  }
}
