import {encodeBase64Url} from '@racrproto/codec';
import {parseDraftContent} from '@racrproto/client-support/drafts';
export async function draftForm(form:FormData){
  const field=(name:string)=>{const v=form.get(name);return typeof v==='string'?v:'';};
  const file=form.get('header');
  if(file instanceof File&&file.size>0&&(file.type!=='image/png'||file.size>196608))throw new Error('Choose a PNG up to 192 KiB.');
  const header=file instanceof File&&file.size>0?encodeBase64Url(new Uint8Array(await file.arrayBuffer())):field('savedHeader')||null;
  return parseDraftContent({audience:field('audience'),category:field('category'),connections:form.getAll('connection'),title:field('title'),text:field('text'),alt:field('alt'),caption:field('caption'),allowReply:field('allowReply')==='yes',header,
    forward:field('forwardSender')||field('forwardMessage')?{sender:field('forwardSender'),messageId:field('forwardMessage')}:null});
}
