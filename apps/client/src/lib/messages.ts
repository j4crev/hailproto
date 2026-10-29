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
  inReplyTo?:{sender:string;messageId:string}|null;
  trashedAt: string | null;
  kind?:"connection";
  connection?:{id:string;epoch:number;active:boolean};
  senderAddress:string|null;
  recipient: string;
  category: string | null;
  blocks: MessageBlock[];
  header: MessageImage | null;
  paragraphs: string[];
  replyUntil:number|null;
  replyAvailable:boolean;
}

export interface MessageLink { href: string; title: string | null; hostname: string }
export interface MessageImage { src: string; alt: string; caption: string | null; width: number; height: number }
export interface MessageSpan { text: string; strong: boolean; emphasis: boolean; code: boolean; link: MessageLink | null }
export interface MessageBlock {
  style: "normal" | "h1" | "h2" | "h3" | "blockquote" | "caption";
  listItem: "bullet" | "number" | null;
  level: number;
  spans: MessageSpan[];
}
export type MessageBlockGroup = { listItem: null; blocks: [MessageBlock] } |
  { listItem: "bullet" | "number"; level: number; blocks: MessageBlock[] };

export function groupMessageBlocks(blocks: MessageBlock[]): MessageBlockGroup[] {
  const groups: MessageBlockGroup[] = [];
  for (const block of blocks) {
    const previous = groups.at(-1);
    if (block.listItem && previous?.listItem === block.listItem && previous.level === block.level) previous.blocks.push(block);
    else groups.push(block.listItem ? { listItem: block.listItem, level: block.level, blocks: [block] } : { listItem: null, blocks: [block] });
  }
  return groups;
}

export function messagePreview(message: Pick<MessageView,"paragraphs">, maximum = 120): string {
  const plain = message.paragraphs.join(" ").replace(/\s+/g, " ").trim();
  const characters = Array.from(plain);
  return characters.length <= maximum ? plain : `${characters.slice(0, maximum - 1).join("")}…`;
}

// Presentation hint only: quoted attribution is not proof of original authorship.
// Recognize the complete legacy forward preamble, not an incidental phrase.
export function forwardedAttribution(blocks: MessageBlock[]) {
  const plain = (block: MessageBlock) => block.spans.map(span => span.text).join("");
  for (let index = 0; index < blocks.length - 1; index++) {
    const heading = blocks[index], metadata = blocks[index + 1];
    if (heading.style !== "normal" || heading.listItem || plain(heading) !== "Forwarded message" ||
      metadata.style !== "normal" || metadata.listItem) continue;
    const lines = plain(metadata).split("\n");
    if (lines.length === 4 && /^From: .+$/.test(lines[0]) && /^Sender DID: did:plc:[a-z2-7]{24}$/.test(lines[1]) &&
      lines[2].startsWith("Originally received: ") && Number.isFinite(Date.parse(lines[2].slice(21))) &&
      /^Message ID: [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(lines[3])) {
      return {heading, metadata};
    }
  }
  return null;
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

export function parseBody(value: unknown): Pick<MessageView,"blocks"|"header"|"paragraphs"> {
  const body = object(value, "message body");
  if (body.version !== 1 || !["spt-1","spt-2","spt-3"].includes(body.profile as string) || !Array.isArray(body.blocks)) {
    throw new Error("Unsupported message body");
  }
  let header:MessageImage|null=null,entries=body.blocks;
  if(body.profile==="spt-3"){
    const manifest=object(body.assets,"asset manifest"),image=object(entries[0],"image block");
    if(manifest.version!==1||!Array.isArray(manifest.assets)||manifest.assets.length!==1||image._type!=="spt.image")throw new Error("Unsupported image body");
    const asset=object(manifest.assets[0],"header asset"),data=text(asset.data,"asset data"),id=text(asset.id,"asset ID");
    if(asset.role!=="header"||asset.media_type!=="image/png"||asset.loading!=="bundled"||image.asset!==id||
      !/^[A-Za-z0-9_-]+$/.test(data)||typeof asset.size!=="number"||asset.size<1||asset.size>196608||Math.floor(data.length*6/8)!==asset.size||
      typeof asset.width!=="number"||!Number.isInteger(asset.width)||asset.width<1||asset.width>2400||typeof asset.height!=="number"||!Number.isInteger(asset.height)||asset.height<1||asset.height>1200||asset.width*asset.height>2000000){
      throw new Error("Unsupported header asset");
    }
    const base64=data.replaceAll("-","+").replaceAll("_","/").padEnd(Math.ceil(data.length/4)*4,"=");
    header={src:`data:image/png;base64,${base64}`,alt:text(image.alt,"image alt"),caption:image.caption===undefined?null:text(image.caption,"image caption"),width:asset.width,height:asset.height};
    entries=entries.slice(1);
  }
  const blocks: MessageBlock[] = entries.map((entry) => {
    const block = object(entry, "body block");
    if (block._type !== "block" || !["normal", "h1", "h2", "h3", "blockquote", "caption"].includes(block.style as string) ||
      !Array.isArray(block.children) || !Array.isArray(block.markDefs)) {
      throw new Error("Unsupported message block");
    }
    const definitions = new Map<string, MessageLink>();
    for (const entry of block.markDefs) {
      const definition = object(entry, "mark definition");
      const key = text(definition._key, "mark key"), href = text(definition.href, "link URL");
      const url = new URL(href);
      if (definition._type !== "spt.link" || url.protocol !== "https:" || url.username || url.password || definitions.has(key)) {
        throw new Error("Unsupported link");
      }
      definitions.set(key, { href, hostname: url.hostname, title: definition.title === undefined ? null : text(definition.title, "link title") });
    }
    const spans = block.children.map((entry) => {
      const span = object(entry, "body span");
      if (span._type !== "span" || !Array.isArray(span.marks)) throw new Error("Unsupported body span");
      const marks = span.marks.map((mark) => text(mark, "span mark"));
      const links = marks.flatMap((mark) => definitions.has(mark) ? [definitions.get(mark)!] : []);
      if (new Set(marks).size !== marks.length || links.length > 1 || marks.some(mark => !["strong", "em", "code"].includes(mark) && !definitions.has(mark))) {
        throw new Error("Unsupported span marks");
      }
      return { text: text(span.text, "body text"), strong: marks.includes("strong"), emphasis: marks.includes("em"),
        code: marks.includes("code"), link: links[0] ?? null };
    });
    const listItem = block.listItem === undefined ? null : block.listItem;
    if (listItem !== null && listItem !== "bullet" && listItem !== "number") throw new Error("Unsupported list type");
    const level = block.level === undefined ? 1 : block.level;
    if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 3 || block.level !== undefined && listItem === null) throw new Error("Unsupported list level");
    if(body.profile==="spt-1"&&(block.style!=="normal"||listItem!==null||block.level!==undefined||block.markDefs.length||spans.some(span=>span.strong||span.emphasis||span.code||span.link)))throw new Error("Unsupported spt-1 extension");
    return { style: block.style as MessageBlock["style"], listItem, level, spans };
  });
  return {blocks,header,paragraphs:blocks.map(block=>block.spans.map(span=>span.text).join(""))};
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
  if(message.kind!==undefined&&message.kind!=="subscription"&&message.kind!=="connection")throw new Error("Unsupported message kind");
  if(message.kind==="connection"&&(message.category!==null||replyUntil!==null||message.replyAvailable===true))throw new Error("Connection messages cannot carry subscription or independent reply authority");
  let connection:MessageView["connection"];
  if(message.connection!==undefined&&message.connection!==null){
    const item=object(message.connection,"connection authorization");
    if(message.kind!=="connection"||typeof item.id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id)||
      !Number.isSafeInteger(item.epoch)||Number(item.epoch)<1||typeof item.active!=="boolean")throw new Error("Invalid message connection");
    connection={id:item.id,epoch:Number(item.epoch),active:item.active};
  }
  return {
    ...(inReplyTo?{inReplyTo}:{}),
    ...(message.kind==="connection"?{kind:"connection" as const}:{}),...(connection?{connection}:{}),
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
