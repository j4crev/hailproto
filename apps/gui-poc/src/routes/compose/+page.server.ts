import { createHash } from "node:crypto";
import { fail,isRedirect,redirect } from "@sveltejs/kit";
import { encodeBase64Url } from "@hailproto/codec";
import { composeBlocks } from "$lib/compose.js";
import { canaryAccount } from "$lib/server/canary.js";
import { messageId } from "$lib/server/message-id.js";

const UUID7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORY=/^[a-z][a-z0-9-]{0,63}$/;

async function targets(cookies:Parameters<typeof canaryAccount>[0],url:URL) {
  const {account,client}=await canaryAccount(cookies,url),page=await client.request("/grants"),rows=Array.isArray(page.grants)?page.grants:[];
  const candidates=rows.flatMap(value=>{
    if(!value||typeof value!=="object"||Array.isArray(value))return [];
    const row=value as Record<string,unknown>;
    return row.localRole==="grantee"&&row.status==="active"&&typeof row.grantId==="string"&&UUID7.test(row.grantId)&&
      (row.expiresAt===null||typeof row.expiresAt==="number"&&row.expiresAt>Math.floor(Date.now()/1000))?[row.grantId]:[];
  });
  const options=(await Promise.all(candidates.map(async id=>{
    try {
      const grant=await client.grant(id),scope=grant.payload.scope[0];
      if(grant.localRole!=="grantee"||grant.payload.grantee!==account.did||grant.payload.status!=="active"||scope?.type!=="categories")return [];
      return scope.values.map(category=>({value:`${id}/${category}`,grantId:id,category,recipient:grant.payload.grantor}));
    } catch{return [];}
  }))).flat();
  return {account,client,options};
}

export async function load({url,cookies}) {
  const {account,client,options}=await targets(cookies,url);
  const messageId=url.searchParams.get("message");
  let status:null|{messageId:string;state:string;revision:number|null}=null;
  if(messageId&&UUID7.test(messageId)){
    try {const value=await client.request(`/messages/${messageId}`);if(value.messageId===messageId&&typeof value.state==="string")
      status={messageId,state:value.state,revision:typeof value.revision==="number"?value.revision:null};}catch{/* Status remains available through refresh. */}
  }
  return {configured:true as const,account,options,status};
}

export const actions={default:async({request,cookies,url})=>{
  try {
    const {client,options}=await targets(cookies,url),form=await request.formData(),field=(name:string)=>{const value=form.get(name);return typeof value==="string"?value:"";};
    const target=field("target"),mode=field("mode"),title=field("title"),text=field("text"),alt=field("alt"),caption=field("caption"),header=form.get("header"),allowReply=field("allowReply")==="yes";
    if(!options.some(option=>option.value===target)||!['plain','rich'].includes(mode)||!text.trim()||Buffer.byteLength(text)>65536||Buffer.byteLength(title)>128||
      Buffer.byteLength(alt)>1024||Buffer.byteLength(caption)>1024)
      return fail(400,{error:"Check the recipient, mode, title, and message text."});
    const separator=target.indexOf("/"),grantId=target.slice(0,separator),category=target.slice(separator+1);
    if(!UUID7.test(grantId)||!CATEGORY.test(category))return fail(400,{error:"The selected Grant is invalid."});
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
    const id=messageId(),result=await client.request("/messages",{messageId:id,grantId,category,
      ...(body?{body}:{text:text.trim()}),...(allowReply?{replyUntil:Math.floor(Date.now()/1000)+7*86400}:{})});
    if(result.messageId!==id)throw new Error("Provider acknowledged another message");
    redirect(303,`/compose?message=${id}`);
  } catch(error){
    if(isRedirect(error))throw error;
    return fail(502,{error:"The message could not be submitted. Verify the Grant and content, then retry."});
  }
}};
