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
      messageId: text(item.messageId, "message ID"),
      sender: text(item.sender, "sender"),
      deliveredAt: text(item.deliveredAt, "delivery time"),
    };
  });
}

export interface MessageView extends InboxItem {
  recipient: string;
  category: string | null;
  blocks: MessageBlock[];
  header: MessageImage | null;
  paragraphs: string[];
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

export function messagePreview(message: MessageView, maximum = 120): string {
  const plain = message.paragraphs.join(" ").replace(/\s+/g, " ").trim();
  const characters = Array.from(plain);
  return characters.length <= maximum ? plain : `${characters.slice(0, maximum - 1).join("")}…`;
}

export function parseMessage(value: unknown): MessageView {
  const message = object(value, "message");
  const body = object(message.body, "message body");
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
  return {
    messageId: text(message.messageId, "message ID"),
    sender: text(message.sender, "sender"),
    recipient: text(message.recipient, "recipient"),
    deliveredAt: text(message.deliveredAt, "delivery time"),
    category: message.category === null ? null : text(message.category, "category"),
    blocks,
    header,
    paragraphs: blocks.map((block) => block.spans.map((span) => span.text).join("")),
  };
}
