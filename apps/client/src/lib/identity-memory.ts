import {get,writable} from "svelte/store";
import {observeIdentity,parseIdentityHistory,type IdentityHistory} from "./identity-history.js";

// Created only from onMount. No account data is held in the SSR process.
const memories=new Map<string,ReturnType<typeof createMemory>>();
function createMemory(owner:string){
  const key=`hail.identity-history.v1:${owner}`;
  const history=writable<IdentityHistory>([]);
  const read=()=>{try{return parseIdentityHistory(localStorage.getItem(key));}catch{return [];}};
  history.set(read());
  return {subscribe:history.subscribe,
    refresh(){history.set(read());},
    observe(did:string,address:string){
      // Merge another tab's observations before writing. Storage is a UI hint,
      // never an authority for address verification or message routing.
      let merged=get(history);
      for(const row of read())if(!merged.some(item=>item.did===row.did&&item.address===row.address))merged=[...merged,row];
      const next=observeIdentity(merged,did,address,Date.now()).slice(-2000);
      history.set(next);
      try{localStorage.setItem(key,JSON.stringify(next));}catch{/* Keep notices in memory if storage is blocked. */}
    },key};
}
export function identityMemory(owner:string){
  let memory=memories.get(owner);
  if(!memory){memory=createMemory(owner);memories.set(owner,memory);}
  return memory;
}
