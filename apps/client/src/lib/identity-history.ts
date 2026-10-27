export const ADDRESS_NOTICE_MS=7*24*60*60*1000;
export const MAX_IDENTITY_OBSERVATIONS=2000;
const DID=/^did:plc:[a-z2-7]{24}$/;
export interface IdentityObservation {did:string;address:string;firstSeen:number;previousAddress:string|null;}
export type IdentityHistory=IdentityObservation[];
export function validIdentity(did:string,address:string):boolean {
  return DID.test(did)&&address.length<=254&&/^[a-z0-9.-]+@[a-z0-9.-]+$/.test(address);
}
export function parseIdentityHistory(raw:string|null):IdentityHistory {
  if(!raw||raw.length>1_500_000)return [];
  try {
    const entries=JSON.parse(raw);
    if(!Array.isArray(entries)||entries.length>MAX_IDENTITY_OBSERVATIONS)return [];
    if(entries.some(row=>!row||typeof row.did!=="string"||typeof row.address!=="string"||!validIdentity(row.did,row.address)||
      !Number.isSafeInteger(row.firstSeen)||row.firstSeen<0||row.previousAddress!==null&&
      (typeof row.previousAddress!=="string"||!validIdentity(row.did,row.previousAddress))))return [];
    return entries;
  }catch{return [];}
}
export function observeIdentity(history:IdentityHistory,did:string,address:string,now:number):IdentityHistory {
  if(!validIdentity(did,address)||history.some(row=>row.did===did&&row.address===address))return history;
  const previous=history.filter(row=>row.did===did).at(-1);
  return [...history,{did,address,firstSeen:now,previousAddress:previous?.address??null}].slice(-MAX_IDENTITY_OBSERVATIONS);
}
export function conflictingIdentities(history:IdentityHistory,did:string,address:string,previousDids:string[]=[]):string[] {
  return [...new Set([...previousDids,...history.filter(row=>row.address===address&&row.did!==did).map(row=>row.did)])]
    .filter(value=>DID.test(value)&&value!==did).sort();
}
export function identityNotice(history:IdentityHistory,did:string,address:string,now:number):{kind:"changed"|"conflict";text:string}|null {
  if(conflictingIdentities(history,did,address).length)return {kind:"conflict",text:
    "This address has been seen with a different Hail identity. It may have been reassigned. Check the identity before granting new permissions. Existing messages and permissions stay with their original identity."};
  const row=history.find(row=>row.did===did&&row.address===address);
  if(!row?.previousAddress||now<row.firstSeen||now-row.firstSeen>=ADDRESS_NOTICE_MS)return null;
  return {kind:"changed",text:`Newly seen address for the same Hail identity. Previously seen as ${row.previousAddress}. This can happen after a provider move or when viewing an older address. Existing permissions stay with the same identity. This notice lasts seven days on this browser.`};
}
// Acknowledgment is bound to the exact review and conflict set, never just a checkbox.
export function identityAcknowledgmentKey(requestId:string,did:string,address:string,previousDids:string[]):string {
  return JSON.stringify([requestId,did,address,[...previousDids].sort()]);
}
