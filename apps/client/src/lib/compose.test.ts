import { describe,expect,it } from "vitest";
import { composeBlocks,formatLines } from "./compose.js";
import {encodePayload,decodePayload,fromDiagnosticJson} from "@hailproto/codec";
import {parseBody,groupMessageBlocks} from "./messages.js";

describe("message composer",()=>{
  it("projects a heading and blank-line-separated paragraphs",()=>{
    const blocks=composeBlocks("Release notes","First paragraph.\n\nSecond paragraph.");
    expect(blocks.map(block=>[block.style,block.children[0]?.text])).toEqual([
      ["h1","Release notes"],["normal","First paragraph."],["normal","Second paragraph."],
    ]);
  });

  it("projects toolbar syntax into safe SPT marks and HTTPS links",()=>{
    const [block]=composeBlocks("","Use **bold**, *italic*, `code`, and [Hail](https://haili.app/docs). ");
    expect(block?.children.map(span=>[span.text,span.marks])).toEqual([
      ["Use ",[]],["bold",["strong"]],[", ",[]],["italic",["em"]],[", ",[]],["code",["code"]],[", and ",[]],["Hail",["link-1"]],[".",[]],
    ]);
    expect(block?.markDefs).toEqual([{_key:"link-1",_type:"spt.link",href:"https://haili.app/docs"}]);
    expect(composeBlocks("","[unsafe](javascript:alert(1))")[0]?.markDefs).toEqual([]);
  });

  it("authors existing rich block types that survive the codec and reader",()=>{
    const body={version:1 as const,profile:"spt-2" as const,blocks:composeBlocks("Release notes","## Highlights\r\n- **One**\r\n- [Two](https://haili.app)\r\n1. First\r\n2. Second\r\n> Keep it safe\r\n### Details\r\nNormal\r\nline\r\n\r\n<img src=x onerror=alert(1)>")};
    expect(body.blocks.map(block=>[block.style,block.listItem??null])).toEqual([["h1",null],["h2",null],["normal","bullet"],["normal","bullet"],["normal","number"],["normal","number"],["blockquote",null],["h3",null],["normal",null],["normal",null]]);
    const validated=fromDiagnosticJson("hail.body.spt-2",JSON.parse(JSON.stringify(body)));
    expect(decodePayload("hail.body.spt-2",encodePayload("hail.body.spt-2",validated))).toEqual(body);
    const view=parseBody(body),groups=groupMessageBlocks(view.blocks);
    expect(groups.filter(group=>group.listItem).map(group=>[group.listItem,group.blocks.length])).toEqual([["bullet",2],["number",2]]);
    expect(view.paragraphs).toContain("Normal\nline");
    expect(view.paragraphs.at(-1)).toBe("<img src=x onerror=alert(1)>");
    expect(composeBlocks("","#### Unsupported\n-\n>\n1.\n  - Indented")[0]?.children[0]?.text).toBe("#### Unsupported\n-\n>\n1.\n  - Indented");
  });

  it("formats whole selected lines without including the next unselected line",()=>{
    const source="Before\nOne\nTwo\nAfter",from=source.indexOf("One"),to=source.indexOf("After");
    const result=formatLines(source,from,to,"- ");
    expect(result.text).toBe("Before\n- One\n- Two\nAfter");
    expect(result.text.slice(result.start,result.end)).toBe("- One\n- Two");
    expect(formatLines(result.text,result.start,result.end,"> ").text).toBe("Before\n> One\n> Two\nAfter");
    expect(formatLines("",0,0,"## ")).toEqual({text:"## ",start:0,end:3});
    expect(formatLines("One\nTwo",5,5,"1. ").text).toBe("One\n1. Two");
  });
});
