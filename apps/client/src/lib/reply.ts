import type {HailSpt2Body} from '@hailproto/codec';
import {messageDisplayContent, parseMessage, type MessageBlock, type MessageView} from './messages.js';

export const REPLY_HEADING='Quoted reply';
const plain=(b:MessageBlock)=>b.spans.map(s=>s.text).join('');
// Display convention only; never use this attribution to establish a thread.
export function replyQuoteIndex(blocks:MessageBlock[]) {
  return blocks.findIndex((b,i)=>b.style==='caption'&&plain(b)===REPLY_HEADING&&
    blocks[i+1]?.style==='caption'&&/^From: .+\nSender DID: did:plc:[a-z2-7]{24}\nReceived: .+\nMessage ID: [0-9a-f-]{36}$/.test(plain(blocks[i+1])));
}
export function replyExcerpt(message:Pick<MessageView,'blocks'|'header'>) {
  const content=messageDisplayContent(message.blocks);
  const index=replyQuoteIndex(content.blocks);
  const blocks=index<0?content.blocks:content.blocks.slice(0,index);
  const text=blocks.map(plain).join('\n\n');
  const chars=Array.from(text);
  return chars.slice(0,4096).join('')+(chars.length>4096?'\n[Excerpt shortened]':'')+
    (message.header?'\n[Image in original message]':'');
}
export function replyBody(value:unknown,reference:{sender:string;messageId:string},text:string):HailSpt2Body {
  const source=parseMessage(value);
  if(source.sender!==reference.sender||source.messageId!==reference.messageId||source.trashedAt)throw new Error('Reply source unavailable');
  if(!text.trim()||new TextEncoder().encode(text).length>65536)throw new Error('Invalid reply text');
  const {title}=messageDisplayContent(source.blocks);
  const block=(text:string,style:'h1'|'normal'|'caption'|'blockquote'):HailSpt2Body['blocks'][number]=>({
    _type:'block' as const,style,children:[{_type:'span' as const,text:text.normalize('NFC'),marks:[]}],markDefs:[],
  });
  const body:HailSpt2Body={version:1,profile:'spt-2',blocks:[
    ...(title?[block(title,'h1')]:[]),
    block(text.trim(),'normal'),block(REPLY_HEADING,'caption'),
    block(`From: ${source.senderAddress??source.sender}\nSender DID: ${source.sender}\nReceived: ${source.deliveredAt}\nMessage ID: ${source.messageId}`,'caption'),
    block(replyExcerpt(source),'blockquote'),
  ]};
  return body;
}
