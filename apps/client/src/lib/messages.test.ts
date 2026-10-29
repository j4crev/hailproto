import { describe, expect, it } from "vitest";
import { groupMessageBlocks, messagePreview, parseInbox, parseInboxFeed, parseMessage, parseSent, parseSentFeed, parseSentMessage } from "./messages.js";

describe("message projections", () => {
  it("accepts the account API inbox and current spt-1 body", () => {
    expect(parseInbox({ messages: [{ messageId: "m", sender: "did:plc:sender", deliveredAt: "now" }] })[0]?.sender)
      .toBe("did:plc:sender");
    const message = parseMessage({
      messageId: "m", sender: "did:plc:sender", recipient: "did:plc:recipient", deliveredAt: "now", category: "updates",reply:{allowed:true,until:123},replyAvailable:true,
      body: { version: 1, profile: "spt-1", blocks: [{ _type: "block", style: "normal", children: [
        { _type: "span", text: "Hello ", marks: [] }, { _type: "span", text: "Hail", marks: [] },
      ], markDefs: [] }] },
    });
    expect(message.paragraphs).toEqual(["Hello Hail"]);
    expect(message.replyUntil).toBe(123);
    expect(message.replyAvailable).toBe(true);
    expect(messagePreview(message)).toBe("Hello Hail");
    expect(Array.from(messagePreview({ ...message, paragraphs: ["🙂".repeat(121)] }))).toHaveLength(120);
  });

  it("projects sent summaries and bodies with delivery status",()=>{
    const item={messageId:"m",recipient:"did:plc:recipient",createdAt:"now",state:"delivered",revision:2,reason:null,retryAt:null};
    expect(parseSent({messages:[item]})).toEqual([item]);
    expect(parseSentMessage({...item,sender:"did:plc:sender",category:"updates",body:{version:1,profile:"spt-1",blocks:[
      {_type:"block",style:"normal",children:[{_type:"span",text:"Sent text",marks:[]}],markDefs:[]},
    ]}})).toMatchObject({state:"delivered",createdAt:"now",paragraphs:["Sent text"]});
    expect(()=>parseSent({messages:[{...item,state:"opened"}]})).toThrow("Invalid sent status");
  });

  it("projects bounded feed pages",()=>{
    const body={version:1,profile:"spt-1",blocks:[{_type:"block",style:"normal",children:[{_type:"span",text:"Page",marks:[]}],markDefs:[]}]};
    expect(parseInboxFeed({messages:[{messageId:"m",sender:"did:plc:sender",senderAddress:"sender@example.com",
      recipient:"did:plc:recipient",deliveredAt:"now",category:null,body}],next:"cursor"})).toMatchObject({next:"cursor",messages:[{senderAddress:"sender@example.com"}]});
    expect(parseSentFeed({messages:[{messageId:"m",sender:"did:plc:sender",recipient:"did:plc:recipient",recipientAddress:null,
      createdAt:"now",category:null,state:"on-hold",revision:2,reason:"sender-rate-limited",retryAt:10,body}],next:null}))
      .toMatchObject({next:null,messages:[{state:"on-hold",reason:"sender-rate-limited",retryAt:10}]});
  });

  it("keeps connection authority separate from subscription categories and one-time replies",()=>{
    const item={messageId:"m",sender:"s",recipient:"r",deliveredAt:"now",category:null,kind:"connection",reply:{allowed:false},replyAvailable:false,
      connection:{id:"01954144-8097-7a9d-a7a8-ef29a823eaf1",epoch:1,active:true},
      body:{version:1,profile:"spt-1",blocks:[{_type:"block",style:"normal",children:[{_type:"span",text:"Personal",marks:[]}],markDefs:[]}]}};
    expect(parseMessage(item)).toMatchObject({kind:"connection",connection:{active:true,epoch:1},replyAvailable:false});
    expect(()=>parseMessage({...item,category:"general"})).toThrow("cannot carry");
    expect(()=>parseMessage({...item,reply:{allowed:true,until:123},replyAvailable:true})).toThrow("cannot carry");
    expect(()=>parseMessage({...item,connection:{...item.connection,id:"javascript:alert(1)"}})).toThrow("Invalid message connection");
  });

  it("rejects a body the POC cannot render safely", () => {
    expect(() => parseMessage({ body: { version: 1, profile: "spt-4", blocks: [] } })).toThrow("Unsupported message body");
    expect(()=>parseMessage({messageId:"m",sender:"s",recipient:"r",deliveredAt:"now",category:null,reply:{allowed:true},
      body:{version:1,profile:"spt-1",blocks:[]}})).toThrow("Unsupported reply invitation");
  });

  it("projects rich text without permitting active links", () => {
    const base={messageId:"m",sender:"did:plc:sender",recipient:"did:plc:recipient",deliveredAt:"now",category:null};
    const message=parseMessage({...base,body:{version:1,profile:"spt-2",blocks:[{_type:"block",style:"h2",
      children:[{_type:"span",text:"Safe link",marks:["strong","link"]}],
      markDefs:[{_key:"link",_type:"spt.link",href:"https://haili.app/news"}]}]}});
    expect(message.blocks[0]).toMatchObject({style:"h2",spans:[{strong:true,link:{hostname:"haili.app"}}]});
    expect(()=>parseMessage({...base,body:{version:1,profile:"spt-2",blocks:[{_type:"block",style:"normal",
      children:[{_type:"span",text:"unsafe",marks:["link"]}],markDefs:[{_key:"link",_type:"spt.link",href:"javascript:alert(1)"}]}]}})).toThrow("Unsupported link");
    const item={...message.blocks[0]!,listItem:"number" as const,level:1};
    expect(groupMessageBlocks([item,item,{...item,listItem:"bullet"}]).map(group=>group.blocks.length)).toEqual([2,1]);
  });

  it("projects a bundled header without a remote request", () => {
    const data=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
    const message=parseMessage({messageId:"m",sender:"did:plc:sender",recipient:"did:plc:recipient",deliveredAt:"now",category:null,
      body:{version:1,profile:"spt-3",assets:{version:1,assets:[{id:"hero",role:"header",media_type:"image/png",loading:"bundled",
        size:data.length,width:1,height:1,data:data.toString("base64url"),digest:{algorithm:"sha-256",value:"ignored-by-view"}}]},
        blocks:[{_type:"spt.image",asset:"hero",alt:"Hail mark"},{_type:"block",style:"normal",children:[{_type:"span",text:"Hello",marks:[]}],markDefs:[]}]}});
    expect(message.header).toMatchObject({alt:"Hail mark",width:1,height:1});
    expect(message.header?.src).toMatch(/^data:image\/png;base64,/);
    expect(messagePreview(message)).toBe("Hello");
  });
});

it("shows send titles separately from previews and retains untitled content",async()=>{
  const {parseSentSend,parseSentSends}=await import("./messages.js");
  const block=(style:string,text:string)=>({_type:"block",style,children:[{_type:"span",text,marks:[]}],markDefs:[]});
  const send={messageId:"send",kind:"category",category:"updates",createdAt:"now",
    body:{version:1,profile:"spt-2",blocks:[block("h1","Weekly news"),block("normal","The update")]}};
  expect(parseSentSend(send)).toMatchObject({title:"Weekly news",preview:"The update"});
  expect(parseSentSend({...send,body:{...send.body,blocks:[block("normal","Keep this opening")]}}))
    .toMatchObject({title:"Untitled message",preview:"Keep this opening"});
  expect(parseSentSends({messages:[send,{...send,messageId:"another"}],next:"cursor"}).messages).toHaveLength(2);
  expect(parseSentSend(send).recipients).toBeNull();
  expect(parseSentSend(send).recipientSummary).toBeNull();
  for(const summary of [{count:1,address:"friend@example.test",did:"did:plc:friend"},{count:2,address:null,did:null}])
    expect(parseSentSend({...send,recipientSummary:summary}).recipientSummary).toEqual(summary);
  expect(()=>parseSentSend({...send,recipientSummary:{count:0,address:null,did:null}})).toThrow("Invalid recipient count");
  const recipients=[{did:"did:plc:recipient",address:"friend@example.test"},{did:"did:plc:other",address:null}];
  expect(parseSentSend({...send,kind:"connections",recipients}).recipients).toEqual(recipients);
  expect(()=>parseSentSend({...send,recipients:{}})).toThrow("Invalid recipients");
  expect(()=>parseSentSend({...send,recipients:[{did:12,address:null}]})).toThrow();
  expect(()=>parseSentSend({...send,kind:"unknown"})).toThrow("Invalid send kind");
});

it("separates inbox and connection subjects from body previews", async () => {
  const {messageListSummary, parseBody} = await import("./messages.js");
  const block = (style: string, text: string) => ({_type:"block", style, children:[{_type:"span", text, marks:[]}], markDefs:[]});
  const summary = (...blocks: ReturnType<typeof block>[]) => messageListSummary(parseBody({version:1, profile:"spt-2", blocks}));
  expect(summary(block("h1", "Subject"), block("normal", "Body preview"))).toEqual({title:"Subject", preview:"Body preview"});
  expect(summary(block("normal", "No subject"))).toEqual({title:"", preview:"No subject"});
  expect(summary(block("h2", "Body heading"), block("normal", "Body"))).toEqual({title:"", preview:"Body heading Body"});
  expect(summary(block("h1", "Subject only"))).toEqual({title:"Subject only", preview:""});
  expect(summary()).toEqual({title:"", preview:""});
});

it("moves only a leading title out of the displayed body", async () => {
  const {messageDisplayContent, parseBody} = await import("./messages.js");
  const block = (style:string, text:string) => ({_type:"block",style,children:[{_type:"span",text,marks:[]}],markDefs:[]});
  const {blocks}=parseBody({version:1,profile:"spt-2",blocks:[block("h1","Message title"),block("normal","Opening paragraph"),block("h1","Later heading")]});
  expect(messageDisplayContent(blocks)).toEqual({title:"Message title",blocks:blocks.slice(1)});
  expect(messageDisplayContent(blocks.slice(1))).toEqual({title:"",blocks:blocks.slice(1)});
  expect(messageDisplayContent([])).toEqual({title:"",blocks:[]});
});
