import {parseBuilderDraft,validateBody,plainText} from '@racrproto/content-builder/core';
import {formAttachments} from '$lib/server/attachments.js';
import {parseDraft,draftIdPattern} from "@racrproto/client-support/drafts";
import {builderDraft} from '$lib/server/builder-draft.js';
import {draftForm} from "$lib/server/draft-form.js";
import {forwardSource, forwardBody} from "$lib/forward.js";
import { createHash } from "node:crypto";
import { error,fail,isRedirect,redirect } from "@sveltejs/kit";
import { fromDiagnosticJson,type DiagnosticJson,encodeBase64Url, encodePayload, type HailSpt2Body, type HailSpt3Body } from "@racrproto/codec";
import { composeBlocks } from "$lib/compose.js";
import { canaryAccount } from "$lib/server/canary.js";
import { messageId } from "$lib/server/message-id.js";
import {publicationAudiences,publicationStatus} from "$lib/publications.js";
import {AccountApiError} from "@racrproto/client-support/account-api";
import {connectionMessageTargets} from "$lib/connections.js";

const UUID7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function load({url,cookies}) {
  const oldMessage=url.searchParams.get("message");if(oldMessage&&UUID7.test(oldMessage))redirect(303,`/sent/${oldMessage}`);
  const {account,client}=await canaryAccount(cookies,url);
  const draftId=url.searchParams.get("draft");
  if(draftId&&!draftIdPattern.test(draftId))error(400,"Invalid draft ID");
  let draft=null;
  if(draftId){try{draft=parseDraft(await client.request(`/drafts/${draftId}`));}catch{error(404,"Draft unavailable. It may have been sent, deleted, or changed on another device.");}}
  const forwardSender=draft?.content.forward?.sender??url.searchParams.get("forwardSender"),forwardMessage=draft?.content.forward?.messageId??url.searchParams.get("forwardMessage");
  if((forwardSender||forwardMessage)&&(!forwardSender||!forwardMessage||!UUID7.test(forwardMessage)||(draft?.content.audience??url.searchParams.get("audience"))!=="connections"))error(400,"Invalid forward source");
  const kind=(draft?.content.audience??url.searchParams.get("audience"))==="connections"?"connections":"category";
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
  let builderInitial:Awaited<ReturnType<typeof builderDraft>>|null=null;
  let builderFallback=false;
  if(!forward){
    try{builderInitial=await builderDraft(draft?.content);}
    catch{builderFallback=true;}
  }
  return {draft,forward,builderInitial,builderFallback,account,...audiences,connections:targets.connections,maxRecipients:kind==="connections"?targets.maxRecipients:audiences.maxRecipients,kind,status,newPublicationId:draft?.id??messageId(),
    defaultConnection:targets.connections.some(t=>t.connectionId===preferred)?preferred:null};
}

export const actions={save:async({request,cookies,url})=>{
  const {client}=await canaryAccount(cookies,url),form=await request.formData();
  const id=form.get("publicationId"),revision=Number(form.get("draftRevision"));
  if(typeof id!=="string"||!draftIdPattern.test(id)||!Number.isSafeInteger(revision)||revision<0)return fail(400,{error:"Invalid draft identity."});
  try{
    const content=await draftForm(form);
    const attachments=await formAttachments(form,client);if(attachments.length)content.attachments=attachments;
    const savedDraft=parseDraft(await client.request(`/drafts/${id}/save`,{revision,content}));
    return {savedDraft};
  }catch(cause){return fail(cause instanceof AccountApiError&&cause.status===409?409:400,{error:cause instanceof AccountApiError?"Draft could not be saved. It may have changed on another device; reopen it from Drafts before trying again.":cause instanceof Error?cause.message:"Unable to save draft."});}
},publish:async({request,cookies,url})=>{
  try {
    const {client}=await canaryAccount(cookies,url),form=await request.formData(),field=(name:string)=>{const value=form.get(name);return typeof value==="string"?value:"";};
    const id=field("publicationId"),category=field("category"),title=field("title"),text=field("text"),alt=field("alt"),caption=field("caption"),header=form.get("header"),allowReply=field("allowReply")==="yes";
    const kind=field("audience")==="connections"?"connections":"category",connections=form.getAll("connection");
    const forwardSender=field("forwardSender"),forwardMessage=field("forwardMessage"),forwarding=form.has("forwardSender")||form.has("forwardMessage");
    if(forwarding&&(kind!=="connections"||!forwardSender||!UUID7.test(forwardMessage)))return fail(400,{error:"Forwards can only be sent to connections."});
    let builder:ReturnType<typeof parseBuilderDraft>|null=null;
    if(form.has('builder')){
      try{builder=parseBuilderDraft(JSON.parse(field('builder')));validateBody(builder.body);}
      catch(cause){return fail(400,{error:cause instanceof Error?cause.message:'Invalid builder content.'});}
      if(forwarding||title||text||alt||caption||field('savedHeader')||header instanceof File&&header.size>0)return fail(400,{error:'Builder content cannot be combined with simple-compose fields.'});
      if(kind==='connections'&&builder.body.profile==='spt-3')return fail(400,{error:'Header images are available for subscriber publications only.'});
      if(!plainText(builder.body).trim())return fail(400,{error:'Write some message text before publishing.'});
    }
    const keys=[...form.keys()];
    if(keys.some(key=>!["builder","attachment","savedAttachments","draftRevision","savedHeader","forwardSender","forwardMessage","publicationId","category","title","text","alt","caption","header","allowReply","audience","connection"].includes(key))||
      new Set(keys.filter(k=>k!=="connection"&&k!=="attachment")).size!==keys.filter(k=>k!=="connection"&&k!=="attachment").length||
      !["","category","connections"].includes(field("audience"))||!UUID7.test(id)||(kind==="category"?!CATEGORY.test(category)||connections.length>0:connections.length<1||connections.length>100||connections.some(v=>typeof v!=="string"||!UUID7.test(v))||new Set(connections).size!==connections.length||form.has("category")||form.has("allowReply"))||
      (!builder&&!forwarding&&!text.trim())||Buffer.byteLength(text)>65536||Buffer.byteLength(title)>128||
      Buffer.byteLength(alt)>1024||Buffer.byteLength(caption)>1024)
      return fail(400,{error:"Check the audience, title, and message text."});
    const savedHeader=field("savedHeader");
    const hasHeader=header instanceof File&&header.size>0||!!savedHeader;
    if(kind==="connections"&&hasHeader)return fail(400,{error:"Header images are available for subscriber publications only."});
    const blocks=composeBlocks(title.trim(),text.trim());
    let body:Record<string,unknown>=builder?builder.body:{version:1,profile:"spt-2",blocks};
    if(!forwarding&&hasHeader){
      if((header instanceof File&&header.size>0&&(header.type!=="image/png"||header.size>196608))||!alt.trim()||savedHeader.length>262144)return fail(400,{error:"Choose a bounded PNG and provide image alt text."});
      const data=header instanceof File&&header.size>0?new Uint8Array(await header.arrayBuffer()):new Uint8Array(Buffer.from(savedHeader,"base64url"));
      if(data.length<24||data.length>196608||Buffer.from(data.subarray(0,8)).toString("hex")!=="89504e470d0a1a0a")return fail(400,{error:"The header is not a valid PNG."});
      const view=new DataView(data.buffer,data.byteOffset,data.byteLength),digest=new Uint8Array(createHash("sha256").update(data).digest());
      body={version:1,profile:"spt-3",assets:{version:1,assets:[{id:"header",role:"header",media_type:"image/png",loading:"bundled",
        size:data.length,digest:{algorithm:"sha-256",value:encodeBase64Url(digest)},width:view.getUint32(16),height:view.getUint32(20),data:encodeBase64Url(data)}]},
        blocks:[{_type:"spt.image",asset:"header",alt:alt.trim(),...(caption.trim()?{caption:caption.trim()}: {})},...blocks]};
    }
    if(forwarding){
      try {
        const source=forwardSource(await client.request(`/inbox/${encodeURIComponent(forwardSender)}/${encodeURIComponent(forwardMessage)}`),{sender:forwardSender,messageId:forwardMessage});
        body=forwardBody(source,text.trim());
      } catch {return fail(400,{error:"The original message is unavailable for forwarding. Return to your inbox and try again."});}
      try {
        const bytes=body.profile==="spt-3"?encodePayload("hail.body.spt-3",fromDiagnosticJson("hail.body.spt-3",body as DiagnosticJson)):encodePayload("hail.body.spt-2",fromDiagnosticJson("hail.body.spt-2",body as DiagnosticJson));
        if(bytes.length>1048576)throw new Error("Body too large");
      } catch {return fail(400,{error:"This forward exceeds the supported message limits. Shorten your note; if it still fails, the original message is too large to forward."});}
    }
    const attachments=await formAttachments(form,client);
    const forwardedFiles=forwarding?(body.attachments??[]) as {filename:string;size:number;digest:{value:string}}[]:[];
    if(attachments.length+forwardedFiles.length>20||[...attachments,...forwardedFiles].reduce((n,f)=>n+f.size,0)>25*1024*1024)return fail(400,{error:'Attachments must total at most 25 MiB across 20 files.'});
    for(const file of forwardedFiles){
      const response=await client.attachment(`/attachments/${encodeURIComponent(forwardSender)}/${encodeURIComponent(forwardMessage)}/${file.digest.value}`);
      attachments.push(await client.request('/attachments',{filename:file.filename,data:Buffer.from(await response.arrayBuffer()).toString('base64url')}) as typeof attachments[number]);
    }
    if(attachments.length)body.attachments=attachments;
    try{
      const result=publicationStatus(await client.request(kind==="connections"?"/connection-messages":"/publications",{publicationId:id,...(Number(field("draftRevision"))>0?{draftRevision:Number(field("draftRevision"))}:{}),
        ...(kind==="connections"?{connections,delivery:connections.length>1?"shared":"private"}:{category,allowReplies:allowReply}),body}),kind);
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
