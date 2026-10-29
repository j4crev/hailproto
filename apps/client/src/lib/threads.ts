export interface ThreadMessage {
  sender:string;messageId:string;sent:boolean;createdAt:string;preview:string;
  inReplyTo:{sender:string;messageId:string}|null;parentAvailable:boolean;
}
export interface MessageThread {messages:ThreadMessage[];truncated:boolean}
const did=/^did:plc:[a-z2-7]{24}$/,id=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseThread(value:unknown):MessageThread {
  const t=value as MessageThread;
  if(!t||!Array.isArray(t.messages)||t.messages.length>50||typeof t.truncated!=='boolean')throw new Error('Invalid conversation');
  for(const m of t.messages){
    if(!m||!did.test(m.sender)||!id.test(m.messageId)||typeof m.sent!=='boolean'||
      typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||typeof m.preview!=='string'||
      typeof m.parentAvailable!=='boolean'||m.inReplyTo!==null&&(!m.inReplyTo||!did.test(m.inReplyTo.sender)||!id.test(m.inReplyTo.messageId)))
      throw new Error('Invalid conversation message');
  }
  return t;
}
export function messageHref(message:{sender:string;messageId:string;sent:boolean}) {
  return message.sent?`/sent/${encodeURIComponent(message.messageId)}`:`/message/${encodeURIComponent(message.sender)}/${encodeURIComponent(message.messageId)}`;
}
