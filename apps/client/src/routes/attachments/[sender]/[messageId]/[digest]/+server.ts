import {canaryAccount} from '$lib/server/canary.js';
import {error} from '@sveltejs/kit';
export async function GET({cookies,url,params}){
  const {client}=await canaryAccount(cookies,url);
  try{
    const response=await client.attachment(`/attachments/${encodeURIComponent(params.sender)}/${encodeURIComponent(params.messageId)}/${encodeURIComponent(params.digest)}${url.search}`);
    const headers=new Headers();
    for(const name of ['Content-Type','Content-Length','Content-Disposition']){const v=response.headers.get(name);if(v)headers.set(name,v);}
    headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Content-Security-Policy',"sandbox; default-src 'none'");
    return new Response(response.body,{headers});
  }catch{error(404,'Attachment unavailable');}
}
