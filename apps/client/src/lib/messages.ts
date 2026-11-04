import {renderBody, type MessageBlock, type MessageImage} from '@racrproto/content-builder/rendering';
export {groupMessageBlocks,forwardedAttribution,type MessageBlock,type MessageBlockGroup,type MessageImage,type MessageSpan,type MessageLink} from '@racrproto/content-builder/rendering';
import {parseAttachments} from '@racrproto/client-support/attachments';
type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

export interface InboxItem {
  isRead?: boolean;
  messageId: string;
  sender: string;
  deliveredAt: string;
}

export function parseInbox(value: unknown): InboxItem[] {
  const result = object(value, "inbox");
  if (!Array.isArray(result.messages)) throw new Error("Invalid inbox messages");
  return result.messages.map((entry) => {
    const item = object(entry, "inbox item");
    return {
      isRead: item.isRead === true,
      messageId: text(item.messageId, "message ID"),
      sender: text(item.sender, "sender"),
      deliveredAt: text(item.deliveredAt, "delivery time"),
    };
  });
}

export interface SentItem {
  messageId: string;
  recipient: string;
  createdAt: string;
  state: "indeterminate" | "accepted" | "on-hold" | "delivered" | "failed" | "cancelled";
  revision: number | null;
  reason: string | null;
  retryAt: number | null;
}

export function parseSent(value: unknown): SentItem[] {
  const result=object(value,"sent messages");
  if(!Array.isArray(result.messages))throw new Error("Invalid sent messages");
  return result.messages.map(entry=>{
    const item=object(entry,"sent item"),state=text(item.state,"delivery state");
    if(!["indeterminate","accepted","on-hold","delivered","failed","cancelled"].includes(state)||
      item.revision!==null&&(!Number.isSafeInteger(item.revision)||Number(item.revision)<1)||
      item.reason!==null&&item.reason!==undefined&&typeof item.reason!=="string"||
      item.retryAt!==null&&item.retryAt!==undefined&&(!Number.isSafeInteger(item.retryAt)||Number(item.retryAt)<0))throw new Error("Invalid sent status");
    return {messageId:text(item.messageId,"message ID"),recipient:text(item.recipient,"recipient"),
      createdAt:text(item.createdAt,"creation time"),state:state as SentItem["state"],revision:item.revision as number|null,
      reason:typeof item.reason==="string"?item.reason:null,retryAt:typeof item.retryAt==="number"?item.retryAt:null};
  });
}

export interface MessageView extends InboxItem {
  sharedConversation?:{creator:string;conversationId:string;messageId:string;state:'active'|'expired'|'left';expiresAt:string;participants:string[];participantAddresses?:Record<string,string>;canRevive:boolean};
  conversation?:{unreadCount:number;lastActivity:string;messages:{sender:string;messageId:string;isRead:boolean}[]};
  inReplyTo?:{sender:string;messageId:string}|null;
  trashedAt: string | null;
  kind?:"connection";
  connection?:{id:string;epoch:number;active:boolean};
  senderAddress:string|null;
  recipient: string;
  category: string | null;
  blocks: MessageBlock[];
  header: MessageImage | null;
  attachments?: {filename:string;size:number;digest:{value:string}}[];
  paragraphs: string[];
  replyUntil:number|null;
  replyAvailable:boolean;
}

export function messagePreview(message: Pick<MessageView,"paragraphs">, maximum = 120): string {
  const plain = message.paragraphs.join(" ").replace(/\s+/g, " ").trim();
  const characters = Array.from(plain);
  return characters.length <= maximum ? plain : `${characters.slice(0, maximum - 1).join("")}…`;
}

export function messageDisplayContent(blocks: MessageBlock[]) {
  const first = blocks[0];
  const title = first?.style === "h1" ? first.spans.map(span => span.text).join("").trim() : "";
  return {title, blocks: title ? blocks.slice(1) : blocks};
}

export function messageListSummary(message: Pick<MessageView,"blocks"|"paragraphs">) {
  const first = message.blocks[0];
  const title = first?.style === "h1" ? first.spans.map(span => span.text).join("").trim() : "";
  return {title, preview: messagePreview({paragraphs: title ? message.paragraphs.slice(1) : message.paragraphs})};
}

export function parseBody(value:unknown) {
  const body=object(value,'body');
  return {...renderBody(body),...(body.attachments===undefined?{}:{attachments:parseAttachments(body.attachments)})};
}

export function parseMessage(value: unknown): MessageView {
  const message = object(value, "message");
  const body = object(message.body, "message body");
  let replyUntil:number|null=null;
  if(message.reply!==undefined){const reply=object(message.reply,"reply invitation");
    if(reply.allowed===true&&Number.isSafeInteger(reply.until)&&Number(reply.until)>0)replyUntil=Number(reply.until);
    else if(reply.allowed!==false||reply.until!==undefined)throw new Error("Unsupported reply invitation");}
  let inReplyTo:MessageView["inReplyTo"];
  if(message.inReplyTo!==undefined&&message.inReplyTo!==null){
    const parent=object(message.inReplyTo,"reply parent");
    if(typeof parent.sender!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(parent.sender)||typeof parent.messageId!=="string"||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parent.messageId))throw new Error("Invalid reply parent");
    inReplyTo={sender:parent.sender,messageId:parent.messageId};
  }
  const content=parseBody(body);
  let conversation:MessageView["conversation"];
  if(message.conversation!==undefined){
    const c=object(message.conversation,"conversation summary");
    if(!Number.isSafeInteger(c.unreadCount)||Number(c.unreadCount)<0||typeof c.lastActivity!=="string"||!Number.isFinite(Date.parse(c.lastActivity))||!Array.isArray(c.messages))throw Error("Invalid conversation summary");
    conversation={unreadCount:Number(c.unreadCount),lastActivity:c.lastActivity,messages:c.messages.map(value=>{
      const m=object(value,"conversation member");
      if(typeof m.sender!=="string"||!/^did:plc:[a-z2-7]{24}$/.test(m.sender)||typeof m.messageId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.messageId)||typeof m.isRead!=="boolean")throw Error("Invalid conversation member");
      return {sender:m.sender,messageId:m.messageId,isRead:m.isRead};
    })};
  }
  if(message.kind!==undefined&&message.kind!=="subscription"&&message.kind!=="connection")throw new Error("Unsupported message kind");
  if(message.kind==="connection"&&(message.category!==null||replyUntil!==null||message.replyAvailable===true))throw new Error("Connection messages cannot carry subscription or independent reply authority");
  let connection:MessageView["connection"];
  let sharedConversation:MessageView['sharedConversation'];
  if(message.sharedConversation!==undefined&&message.sharedConversation!==null){
    const s=object(message.sharedConversation,'shared conversation'),did=/^did:plc:[a-z2-7]{24}$/,id=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if(message.kind!=='connection'||typeof s.creator!=='string'||!did.test(s.creator)||typeof s.conversationId!=='string'||!id.test(s.conversationId)||
      typeof s.messageId!=='string'||!id.test(s.messageId)||!['active','expired','left'].includes(s.state as string)||typeof s.expiresAt!=='string'||!Number.isFinite(Date.parse(s.expiresAt))||
      !Array.isArray(s.participants)||s.participants.length<3||s.participants.length>101||s.participants.some(v=>typeof v!=='string'||!did.test(v))||
      new Set(s.participants).size!==s.participants.length||!s.participants.includes(s.creator)||typeof s.canRevive!=='boolean')throw new Error('Invalid shared conversation');
    if(s.participantAddresses!==undefined){
      const addresses=object(s.participantAddresses,'participant addresses');
      if(Object.entries(addresses).some(([peer,address])=>!(s.participants as string[]).includes(peer)||typeof address!=='string'||address.length>254||!/^([^\s@]+)@([^\s@]+)$/.test(address)))throw new Error('Invalid participant addresses');
    }
    sharedConversation=s as unknown as NonNullable<MessageView['sharedConversation']>;
  }
  if(message.connection!==undefined&&message.connection!==null){
    const item=object(message.connection,"connection authorization");
    if(message.kind!=="connection"||typeof item.id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)||
      !Number.isSafeInteger(item.epoch)||Number(item.epoch)<1||typeof item.active!=="boolean")throw new Error("Invalid message connection");
    connection={id:item.id,epoch:Number(item.epoch),active:item.active};
  }
  return {
    ...(conversation?{conversation}:{}),
    ...(inReplyTo?{inReplyTo}:{}),
    ...(message.kind==="connection"?{kind:"connection" as const}:{}),...(connection?{connection}:{}),...(sharedConversation?{sharedConversation}:{}),
    trashedAt: message.trashedAt == null ? null : text(message.trashedAt, "trash time"),
    isRead: message.isRead === true,
    messageId: text(message.messageId, "message ID"),
    sender: text(message.sender, "sender"),
    senderAddress:message.senderAddress===null||message.senderAddress===undefined?null:text(message.senderAddress,"sender address"),
    recipient: text(message.recipient, "recipient"),
    deliveredAt: text(message.deliveredAt, "delivery time"),
    category: message.category === null ? null : text(message.category, "category"),
    blocks:content.blocks,
    header:content.header,
    attachments:content.attachments,
    paragraphs:content.paragraphs,
    replyUntil,
    replyAvailable:message.trashedAt == null && message.replyAvailable===true,
  };
}

export interface SentMessageView extends Omit<MessageView,"deliveredAt"> {
  createdAt:string;
  recipientAddress:string|null;
  state:SentItem["state"];
  revision:number|null;
  reason:string|null;
  retryAt:number|null;
}

export function parseSentMessage(value:unknown):SentMessageView {
  const sent=object(value,"sent message"),createdAt=text(sent.createdAt,"creation time"),state=text(sent.state,"delivery state");
  const [status]=parseSent({messages:[sent]});
  const message=parseMessage({...sent,deliveredAt:createdAt});
  const {deliveredAt:_,...view}=message;
  return {...view,createdAt,recipientAddress:sent.recipientAddress===null||sent.recipientAddress===undefined?null:text(sent.recipientAddress,"recipient address"),
    state:state as SentItem["state"],revision:status!.revision,reason:status!.reason,retryAt:status!.retryAt};
}

function nextCursor(value:unknown):string|null {
  if(value===null)return null;
  return text(value,"next cursor");
}

export function parseInboxFeed(value:unknown) {
  const page=object(value,"inbox feed");
  if(!Array.isArray(page.messages))throw new Error("Invalid inbox feed");
  return {messages:page.messages.map(parseMessage),next:nextCursor(page.next)};
}

export function parseSentFeed(value:unknown) {
  const page=object(value,"sent feed");
  if(!Array.isArray(page.messages))throw new Error("Invalid sent feed");
  return {messages:page.messages.map(parseSentMessage),next:nextCursor(page.next)};
}

export function parseSentSend(value:unknown) {
  const item=object(value,"sent send");
  if(!["category","connections","message"].includes(item.kind as string))throw new Error("Invalid send kind");
  if(item.recipients!==undefined&&(!Array.isArray(item.recipients)||item.recipients.length>100))throw new Error("Invalid recipients");
  const recipients = item.recipients===undefined ? null : (item.recipients as unknown[]).map(value=>{
    const recipient=object(value,"recipient");
    return {did:text(recipient.did,"recipient DID"),address:recipient.address===null?null:text(recipient.address,"recipient address")};
  });
  let recipientSummary:{count:number;address:string|null;did:string|null}|null=null;
  if(item.recipientSummary!==undefined){
    const summary=object(item.recipientSummary,"recipient summary");
    if(!Number.isSafeInteger(summary.count)||Number(summary.count)<1||Number(summary.count)>100)throw new Error("Invalid recipient count");
    recipientSummary={count:Number(summary.count),address:summary.address===null?null:text(summary.address,"recipient address"),did:summary.did===null?null:text(summary.did,"recipient DID")};
  }
  const content=parseBody(item.body),first=content.blocks[0];
  const title=first?.style==="h1"?first.spans.map(span=>span.text).join("").trim():"";
  const paragraphs=title?content.paragraphs.slice(1):content.paragraphs;
  return {...content,messageId:text(item.messageId,"send ID"),kind:item.kind as "category"|"connections"|"message",
    category:item.category===null?null:text(item.category,"category"),createdAt:text(item.createdAt,"creation time"),
    title:title||"Untitled message",preview:messagePreview({paragraphs}),recipients,recipientSummary};
}

export function parseSentSends(value:unknown) {
  const page=object(value,"sent sends");
  if(!Array.isArray(page.messages))throw new Error("Invalid sent sends");
  return {messages:page.messages.map(parseSentSend),next:nextCursor(page.next)};
}
