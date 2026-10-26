import {verifySignature} from '@atproto/crypto';
import {decodeDeterministic,encodeDeterministic,type HailValue} from '@hailproto/codec';
import {ed25519PublicKeyFromDidKey} from '../identity/did-key.js';
import {canonicalizeHailServiceBase} from '../plc/resolver.js';
import type {SignedHandshake} from './handshake.js';

export interface ConnectionTransferCancellation {
  type:'hail.connection-transfer-cancellation';version:1;did:string;transfer_id:string;snapshot_digest:Uint8Array;
  source_service_base:string;destination_service_base:string;issued_at:number;expires_at:number;
}
export function connectionCancellationInput(role:'owner-cancel'|'destination-cancelled',bytes:Uint8Array):Uint8Array<ArrayBuffer>{
  const prefix=new TextEncoder().encode('hail.connection-transfer.'+role+'.v1\0'),result=new Uint8Array(prefix.length+bytes.length);result.set(prefix);result.set(bytes,prefix.length);return result;
}
export function decodeConnectionCancellation(signed:SignedHandshake):ConnectionTransferCancellation {
  if(!signed.payloadBytes.length||signed.payloadBytes.length>4096||signed.signature.length!==64)throw new Error('Invalid connection cancellation representation');
  const v=decodeDeterministic(signed.payloadBytes) as unknown as ConnectionTransferCancellation;
  if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='destination_service_base,did,expires_at,issued_at,snapshot_digest,source_service_base,transfer_id,type,version'||
    v.type!=='hail.connection-transfer-cancellation'||v.version!==1||!/^did:plc:[a-z2-7]{24}$/.test(v.did)||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v.transfer_id)||
    !(v.snapshot_digest instanceof Uint8Array)||v.snapshot_digest.length!==32||!Number.isSafeInteger(v.issued_at)||!Number.isSafeInteger(v.expires_at)||v.issued_at<0||v.expires_at<=v.issued_at||v.expires_at-v.issued_at>3600||
    canonicalizeHailServiceBase(v.source_service_base)!==v.source_service_base||canonicalizeHailServiceBase(v.destination_service_base)!==v.destination_service_base||
    v.source_service_base===v.destination_service_base||!Buffer.from(encodeDeterministic(v as unknown as HailValue)).equals(Buffer.from(signed.payloadBytes)))throw new Error('Invalid connection cancellation');
  return v;
}
export async function verifyConnectionCancellation(signed:SignedHandshake,key:string,role:'owner-cancel'|'destination-cancelled',managedOwner=false){
  const value=decodeConnectionCancellation(signed),input=connectionCancellationInput(role,signed.payloadBytes);
  const valid=managedOwner?await verifySignature(key,input,signed.signature):await crypto.subtle.verify('Ed25519',await ed25519PublicKeyFromDidKey(key),Uint8Array.from(signed.signature),input);
  if(!valid)throw new Error('Connection cancellation purpose or signature differs');return value;
}
