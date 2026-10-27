import {validIdentity} from "./identity-history.js";
export interface ConnectionAddress {did:string;address:string;previousAddress:string|null;changedAt:string|null;}
const pending=new Map<string,{at:number;value:Promise<ConnectionAddress|null|undefined>}>();
// Memory only. Bound to both account DID and peer; never persist authenticated
// responses across browser sessions. Same-page duplicates share one request.
export async function connectionAddress(owner:string,did:string):Promise<ConnectionAddress|null|undefined>{
  const key=owner+'\0'+did,now=Date.now(),cached=pending.get(key);
  if(cached&&now-cached.at<60_000)return cached.value;
  if(pending.size>=500)pending.clear();
  const value=(async()=>{
    try{
      const response=await fetch('/api/v1/account/connection-addresses/'+encodeURIComponent(did),{
        credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10_000)});
      if(!response.ok)return undefined;
      const result=await response.json(),contact=result.contact;
      if(result.owner!==owner)return undefined;
      if(contact===null)return null;
      if(!contact||contact.did!==did||typeof contact.address!=="string"||!validIdentity(did,contact.address)||
        contact.previousAddress!==null&&(typeof contact.previousAddress!=="string"||!validIdentity(did,contact.previousAddress))||
        contact.changedAt!==null&&(typeof contact.changedAt!=="string"||!Number.isFinite(Date.parse(contact.changedAt))))return undefined;
      return contact as ConnectionAddress;
    }catch{return undefined;}
  })();
  pending.set(key,{at:now,value});return value;
}
