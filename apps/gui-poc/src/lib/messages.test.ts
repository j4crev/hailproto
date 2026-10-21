import { describe, expect, it } from "vitest";
import { groupMessageBlocks, messagePreview, parseInbox, parseMessage, parseSent, parseSentMessage } from "./messages.js";

describe("message projections", () => {
  it("accepts the account API inbox and current spt-1 body", () => {
    expect(parseInbox({ messages: [{ messageId: "m", sender: "did:plc:sender", deliveredAt: "now" }] })[0]?.sender)
      .toBe("did:plc:sender");
    const message = parseMessage({
      messageId: "m", sender: "did:plc:sender", recipient: "did:plc:recipient", deliveredAt: "now", category: "updates",
      body: { version: 1, profile: "spt-1", blocks: [{ _type: "block", style: "normal", children: [
        { _type: "span", text: "Hello ", marks: [] }, { _type: "span", text: "Hail", marks: [] },
      ], markDefs: [] }] },
    });
    expect(message.paragraphs).toEqual(["Hello Hail"]);
    expect(messagePreview(message)).toBe("Hello Hail");
    expect(Array.from(messagePreview({ ...message, paragraphs: ["🙂".repeat(121)] }))).toHaveLength(120);
  });

  it("projects sent summaries and bodies with delivery status",()=>{
    const item={messageId:"m",recipient:"did:plc:recipient",createdAt:"now",state:"delivered",revision:2};
    expect(parseSent({messages:[item]})).toEqual([item]);
    expect(parseSentMessage({...item,sender:"did:plc:sender",category:"updates",body:{version:1,profile:"spt-1",blocks:[
      {_type:"block",style:"normal",children:[{_type:"span",text:"Sent text",marks:[]}],markDefs:[]},
    ]}})).toMatchObject({state:"delivered",createdAt:"now",paragraphs:["Sent text"]});
    expect(()=>parseSent({messages:[{...item,state:"opened"}]})).toThrow("Invalid sent status");
  });

  it("rejects a body the POC cannot render safely", () => {
    expect(() => parseMessage({ body: { version: 1, profile: "spt-4", blocks: [] } })).toThrow("Unsupported message body");
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
