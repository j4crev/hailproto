import {parseBuilderDraft,type BuilderDraft,plainText} from '@racrproto/content-builder/core';
import {parseAttachments,type AttachmentMetadata} from './attachments.js';
/** Provider-local editable compose state, never a signed message body. */
export type DraftContent={builder?:BuilderDraft;attachments?:AttachmentMetadata[];audience:'category'|'connections';category:string;connections:string[];title:string;text:string;alt:string;caption:string;allowReply:boolean;header:string|null;forward:{sender:string;messageId:string}|null};
export type Draft={id:string;revision:number;content:DraftContent;updatedAt:string;trashedAt:string|null};
export const draftIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseDraftContent(value:unknown):DraftContent {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid draft');
  const v=value as DraftContent;
  const keys=['audience','category','connections','title','text','alt','caption','allowReply','header','forward'];
  if(Object.keys(v).filter(k=>k!=='attachments'&&k!=='builder').length!==keys.length||Object.keys(v).some(k=>k!=='attachments'&&k!=='builder'&&!keys.includes(k)))throw new Error('Invalid draft fields');
  for(const [key,max] of [['category',64],['title',128],['text',65536],['alt',1024],['caption',1024]] as const)
    if(typeof v[key]!=='string'||new TextEncoder().encode(v[key]).length>max)throw new Error('Draft text exceeds limits');
  if(!['category','connections'].includes(v.audience)||typeof v.allowReply!=='boolean'||
    (v.category!==''&&!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v.category))||!Array.isArray(v.connections)||v.connections.length>100||
    v.connections.some(id=>typeof id!=='string'||!draftIdPattern.test(id))||new Set(v.connections).size!==v.connections.length)throw new Error('Invalid draft audience');
  if(v.header!==null&&(typeof v.header!=='string'||v.header.length>262144||!/^iVBORw0KGgo[A-Za-z0-9_-]*$/.test(v.header)))throw new Error('Invalid draft PNG');
  if(v.forward!==null&&(!v.forward||typeof v.forward!=='object'||Object.keys(v.forward).sort().join(',')!=='messageId,sender'||
    typeof v.forward.sender!=='string'||!/^did:plc:[a-z2-7]{24}$/.test(v.forward.sender)||typeof v.forward.messageId!=='string'||!draftIdPattern.test(v.forward.messageId)))throw new Error('Invalid forward source');
  if(v.audience==='connections'&&(v.category||v.allowReply||v.header)||v.audience==='category'&&(v.connections.length||v.forward))throw new Error('Invalid draft audience fields');
  if(v.builder!==undefined){
    const builder=parseBuilderDraft(v.builder);
    if(v.forward||v.title||v.text||v.header||v.alt||v.caption)throw new Error('Builder drafts cannot contain simple-compose fields or a forward');
    if(v.audience==='connections'&&builder.body.profile==='spt-3')throw new Error('Connection drafts cannot contain a header');
  }
  if(v.attachments!==undefined)parseAttachments(v.attachments);
  return v;
}
export function parseDraft(value:unknown):Draft {
  const v=value as Draft;
  if(!v||typeof v.id!=='string'||!draftIdPattern.test(v.id)||!Number.isSafeInteger(v.revision)||v.revision<1||typeof v.updatedAt!=='string'||!Number.isFinite(Date.parse(v.updatedAt))||
    !(v.trashedAt===null||typeof v.trashedAt==='string'&&Number.isFinite(Date.parse(v.trashedAt))))throw new Error('Invalid draft response');
  return {...v,content:parseDraftContent(v.content)};
}
export function parseDraftList(value:Record<string,unknown>){
  if(!Array.isArray(value.drafts)||!(value.next===null||typeof value.next==='string'&&draftIdPattern.test(value.next)))throw new Error('Invalid draft list');
  return {drafts:value.drafts.map(parseDraft),next:value.next as string|null};
}

export function draftText(content:DraftContent){return content.builder?plainText(content.builder.body):content.text;}
export function draftTitle(content:DraftContent){if(!content.builder)return content.title;const block=content.builder.body.blocks.find(b=>b._type==='block');return block?._type==='block'&&block.style==='h1'?block.children.map(s=>s.text).join(''):'';}
