import { createHash } from "node:crypto";
import { error,fail,isRedirect,redirect } from "@sveltejs/kit";
import { encodeBase64Url } from "@hailproto/codec";
import { composeBlocks } from "$lib/compose.js";
import { canaryAccount } from "$lib/server/canary.js";
import { messageId } from "$lib/server/message-id.js";
import {publicationAudiences,publicationStatus,recentPublications} from "$lib/publications.js";
import {AccountApiError} from "../../../../cli/src/account-api.js";

const UUID7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function load({url,cookies}) {
  const oldMessage=url.searchParams.get("message");if(oldMessage&&UUID7.test(oldMessage))redirect(303,`/sent/${oldMessage}`);
  const {account,client}=await canaryAccount(cookies,url),audiences=publicationAudiences(await client.request("/publications/audiences"));
  const id=url.searchParams.get("publication");if(id&&!UUID7.test(id))error(400,"Invalid publication ID");
  let status:ReturnType<typeof publicationStatus>|null=null;
  if(id){try{status=publicationStatus(await client.request(`/publications/${id}`));}
    catch(cause){if(cause instanceof AccountApiError&&cause.status===404)error(404,"Publication unavailable for this account");throw cause;}
    if(status.publicationId!==id)error(502,"Provider returned another publication");}
  const recent=recentPublications(await client.request("/publications"));
  return {account,...audiences,status,recent,newPublicationId:messageId(),defaultCategory:audiences.categories.some(row=>row.category==="general")?"general":""};
}

export const actions={publish:async({request,cookies,url})=>{
  try {
    const {client}=await canaryAccount(cookies,url),form=await request.formData(),field=(name:string)=>{const value=form.get(name);return typeof value==="string"?value:"";};
    const id=field("publicationId"),category=field("category"),mode=field("mode"),title=field("title"),text=field("text"),alt=field("alt"),caption=field("caption"),header=form.get("header"),allowReply=field("allowReply")==="yes";
    const keys=[...form.keys()];
    if(keys.some(key=>!["publicationId","category","mode","title","text","alt","caption","header","allowReply"].includes(key))||new Set(keys).size!==keys.length||
      !UUID7.test(id)||!CATEGORY.test(category)||!['plain','rich'].includes(mode)||!text.trim()||Buffer.byteLength(text)>65536||Buffer.byteLength(title)>128||
      Buffer.byteLength(alt)>1024||Buffer.byteLength(caption)>1024)
      return fail(400,{error:"Check the category, mode, title, and message text."});
    const hasHeader=header instanceof File&&header.size>0;
    if(mode==="plain"&&(title||hasHeader))return fail(400,{error:"Titles and headers require rich mode."});
    let body:Record<string,unknown>|undefined;
    if(mode==="rich"){
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
    try{
      const result=publicationStatus(await client.request("/publications",{publicationId:id,category,...(body?{body}:{text:text.trim()}),allowReplies:allowReply}));
      if(result.publicationId!==id)throw new Error("Provider acknowledged another publication");
    }catch{
      // A lost acceptance response must not cause another publication or another audience snapshot.
      return fail(502,{error:"Publication not confirmed; it may already be queued. Check this original request before trying again.",publicationId:id});
    }
    redirect(303,`/compose?publication=${id}`);
  } catch(error){
    if(isRedirect(error))throw error;
    return fail(502,{error:"The publication could not be confirmed. Check its original status before retrying."});
  }
},cancel:async({request,cookies,url})=>{
  const {client}=await canaryAccount(cookies,url),form=await request.formData(),id=form.get("publicationId");
  if(typeof id!=="string"||!UUID7.test(id))return fail(400,{error:"Invalid publication ID"});
  try{const stopped=publicationStatus(await client.request(`/publications/${id}/cancel`,{}));if(stopped.publicationId!==id)throw new Error("Another publication was returned");}
  catch{return fail(409,{error:"Publication work may be in progress. Refresh its status and retry cancellation.",publicationId:id});}
  redirect(303,`/compose?publication=${id}`);
}};
