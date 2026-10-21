import { describe,expect,it } from "vitest";
import { composeBlocks } from "./compose.js";

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
});
