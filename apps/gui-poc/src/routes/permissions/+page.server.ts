import {canaryAccount,isConfigured,ORIGIN} from "$lib/server/canary.js";
import {isRedirect} from "@sveltejs/kit";

export async function load({url,cookies,setHeaders}){
  setHeaders({"cache-control":"no-store","referrer-policy":"no-referrer"});
  if(!isConfigured(cookies))return {configured:false as const,origin:ORIGIN};
  let current:Awaited<ReturnType<typeof canaryAccount>>;
  try{current=await canaryAccount(cookies);}catch(error){
    // Keep the public QR fragment on this page while an expired session signs
    // in again, rather than redirecting to login and losing the sender pin.
    if(isRedirect(error)&&error.location==="/auth/login")return {configured:false as const,origin:ORIGIN};
    throw error;
  }
  const {account,client}=current,after=url.searchParams.get("after");
  const page=await client.request(`/grants${after?`?after=${encodeURIComponent(after)}`:""}`);
  if(!Array.isArray(page.grants)||page.next!==null&&typeof page.next!=="string")throw new Error("Invalid allowed-sender list");
  const permissions=await Promise.all(page.grants.filter((row:any)=>row?.localRole==="grantor").map(async(row:any)=>{
    const grant=await client.grant(row.grantId);
    if(grant.localRole!=="grantor"||grant.payload.grantor!==account.did)throw new Error("Invalid permission owner");
    return {grantId:grant.payload.grant_id,sender:grant.payload.consent_context.grantee_address,did:grant.payload.grantee,
      scope:grant.payload.scope[0],status:grant.payload.status,revision:grant.payload.revision,expiresAt:grant.payload.expires_at,
      digest:grant.digest};
  }));
  return {configured:true as const,account,origin:ORIGIN,permissions,next:page.next as string|null};
}
