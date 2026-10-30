import {forwardSource, forwardBody} from "$lib/forward.js";
import { createHash } from "node:crypto";
import { error,fail,isRedirect,redirect } from "@sveltejs/kit";
import { encodeBase64Url, encodePayload, type HailSpt2Body, type HailSpt3Body } from "@hailproto/codec";
import { composeBlocks } from "$lib/compose.js";
import { canaryAccount } from "$lib/server/canary.js";
import { messageId } from "$lib/server/message-id.js";
import {publicationAudiences,publicationStatus} from "$lib/publications.js";
import {AccountApiError} from "../../../../../packages/hail-client-support/src/account-api.js";
import {connectionMessageTargets} from "$lib/connections.js";

const UUID7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function load({url,cookies}) {
  const oldMessage=url.searchParams.get("message");if(oldMessage&&UUID7.test(oldMessage))redirect(303,`/sent/${oldMessage}`);
  const forwardSender=url.searchParams.get("forwardSender"),forwardMessage=url.searchParams.get("forwardMessage");
  if((forwardSender||forwardMessage)&&(!forwardSender||!forwardMessage||!UUID7.test(forwardMessage)||url.searchParams.get("audience")!=="connections"))error(400,"Invalid forward source");
  const kind=url.searchParams.get("audience")==="connections"?"connections":"category";
  const {account,client}=await canaryAccount(cookies,url);
  const [audiences,targets]=await Promise.all([
    client.request("/publications/audiences").then(publicationAudiences),
    kind==="connections"?client.request("/connection-messages/targets").then(connectionMessageTargets):{maxRecipients:100,connections:[]},
  ]);
  const endpoint=kind==="connections"?"/connection-messages":"/publications";
  const id=url.searchParams.get("publication");if(id&&!UUID7.test(id))error(400,"Invalid publication ID");
  // A validated provider record confirms durable acceptance, independently of recipient delivery.
  let status:ReturnType<typeof publicationStatus>|null=null;
  if(id){try{status=publicationStatus(await client.request(`${endpoint}/${id}`),kind);}
    catch(cause){if(cause instanceof AccountApiError&&cause.status===404)error(404,"Publication unavailable for this account");throw cause;}
    if(status.publicationId!==id)error(502,"Provider returned another publication");}
  const preferred=url.searchParams.get("connection");
  let forward:ReturnType<typeof forwardSource>|null=null;
  if(forwardSender&&forwardMessage){
    try {forward=forwardSource(await client.request(`/inbox/${encodeURIComponent(forwardSender)}/${encodeURIComponent(forwardMessage)}`),{sender:forwardSender,messageId:forwardMessage});}
    catch {error(404,"Original message unavailable for forwarding");}
  }
  return {forward,account,...audiences,connections:targets.connections,maxRecipients:kind==="connections"?targets.maxRecipients:audiences.maxRecipients,kind,status,newPublicationId:messageId(),
    defaultConnection:targets.connections.some(t=>t.connectionId===preferred)?preferred:null,defaultCategory:audiences.categories.some(row=>row.category==="general")?"general":""};
}

export const actions={publish:async({request,cookies,url})=>{
  try {
    const {client}=await canaryAccount(cookies,url),form=await request.formData(),field=(name:string)=>{const value=form.get(name);return typeof value==="string"?value:"";};
    const id=field("publicationId"),category=field("category"),mode=field("mode"),title=field("title"),text=field("text"),alt=field("alt"),caption=field("caption"),header=form.get("header"),allowReply=field("allowReply")==="yes";
    const kind=field("audience")==="connections"?"connections":"category",connections=form.getAll("connection");
    const forwardSender=field("forwardSender"),forwardMessage=field("forwardMessage"),forwarding=form.has("forwardSender")||form.has("forwardMessage");
    if(forwarding&&(kind!=="connections"||!forwardSender||!UUID7.test(forwardMessage)))return fail(400,{error:"Forwards can only be sent to connections."});
    const keys=[...form.keys()];
    if(keys.some(key=>!["forwardSender","forwardMessage","publicationId","category","mode","title","text","alt","caption","header","allowReply","audience","connection"].includes(key))||
      new Set(keys.filter(k=>k!=="connection")).size!==keys.filter(k=>k!=="connection").length||
      !["","category","connections"].includes(field("audience"))||!UUID7.test(id)||(kind==="category"?!CATEGORY.test(category)||connections.length>0:connections.length<1||connections.length>100||connections.some(v=>typeof v!=="string"||!UUID7.test(v))||new Set(connections).size!==connections.length||form.has("category")||form.has("allowReply"))||
      !['plain','rich'].includes(mode)||(!forwarding&&!text.trim())||Buffer.byteLength(text)>65536||Buffer.byteLength(title)>128||
      Buffer.byteLength(alt)>1024||Buffer.byteLength(caption)>1024)
      return fail(400,{error:"Check the category, mode, title, and message text."});
    const hasHeader=header instanceof File&&header.size>0;
    if(mode==="plain"&&(title||hasHeader))return fail(400,{error:"Titles and headers require rich mode."});
    let body:Record<string,unknown>|undefined;
    if(mode==="rich"&&!forwarding){
      const blocks=composeBlocks(title.trim(),text.trim());
      if(hasHeader){
        if(!(header instanceof File)||header.type!=="image/png"||header.size>196608||!alt.trim())return fail(400,{error:"Choose a bounded PNG and provide image alt text."});
        const data=new Uint8Array(await header.arrayBuffer());
        if(data.length<24)return fail(400,{error:"The header is not a valid PNG."});
        const view=new DataView(data.buffer,data.byteOffset,data.byteLength),digest=new Uint8Array(createHash("sha256").update(data).digest());
        body={version:1,profile:"spt-3",assets:{version:1,assets:[{id:"header",role:"header",media_type:"image/png",loading:"bundled",
          size:data.length,digest:{algorithm:"sha-256",value:encodeBase64Url(digest)},width:view.getUint32(16),height:view.getUint32(20),data:encodeBase64Url(data)}]},
          blocks:[{_type:"spt.image",asset:"header",alt:alt.trim(),...(caption.trim()?{caption:caption.trim()}: {})},...blocks]};
      } else body={version:1,profile:"spt-2",blocks};
    }
    if(forwarding){
      try {
        const source=forwardSource(await client.request(`/inbox/${encodeURIComponent(forwardSender)}/${encodeURIComponent(forwardMessage)}`),{sender:forwardSender,messageId:forwardMessage});
        body=forwardBody(source,text.trim());
      } catch {return fail(400,{error:"The original message is unavailable for forwarding. Return to your inbox and try again."});}
      try {
        const bytes=body.profile==="spt-3"?encodePayload("hail.body.spt-3",body as unknown as HailSpt3Body):encodePayload("hail.body.spt-2",body as unknown as HailSpt2Body);
        if(bytes.length>262144)throw new Error("Body too large");
      } catch {return fail(400,{error:"This forward exceeds the supported message limits. Shorten your note; if it still fails, the original message is too large to forward."});}
    }
    try{
      const result=publicationStatus(await client.request(kind==="connections"?"/connection-messages":"/publications",{publicationId:id,
        ...(kind==="connections"?{connections}:{category,allowReplies:allowReply}),...(body?{body}:{text:text.trim()})}),kind);
      if(result.publicationId!==id)throw new Error("Provider acknowledged another publication");
    }catch{
      // A lost acceptance response must not cause another publication or another audience snapshot.
      return fail(502,{error:`${kind==='connections'?'Message batch':'Publication'} not confirmed; it may already be queued. Check this original request before trying again.`,publicationId:id});
    }
    redirect(303,`/compose?${kind==="connections"?"audience=connections&":""}publication=${id}`);
  } catch(error){
    if(isRedirect(error))throw error;
    return fail(502,{error:"The publication could not be confirmed. Check its original status before retrying."});
  }
},cancel:async({request,cookies,url})=>{
  const {client}=await canaryAccount(cookies,url),form=await request.formData(),id=form.get("publicationId");
  if(typeof id!=="string"||!UUID7.test(id))return fail(400,{error:"Invalid publication ID"});
  const kind=url.searchParams.get("audience")==="connections"?"connections":"category";
  try{const stopped=publicationStatus(await client.request(`${kind==="connections"?"/connection-messages":"/publications"}/${id}/cancel`,{}),kind);if(stopped.publicationId!==id)throw new Error("Another publication was returned");}
  catch{return fail(409,{error:"Publication work may be in progress. Refresh its status and retry cancellation.",publicationId:id});}
  redirect(303,`/compose?${kind==="connections"?"audience=connections&":""}publication=${id}`);
}};
