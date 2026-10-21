import { describe,expect,it } from "vitest";
import { composeBlocks } from "./compose.js";

describe("message composer",()=>{
  it("projects a heading and blank-line-separated paragraphs",()=>{
    const blocks=composeBlocks("Release notes","First paragraph.\n\nSecond paragraph.");
    expect(blocks.map(block=>[block.style,block.children[0].text])).toEqual([
      ["h1","Release notes"],["normal","First paragraph."],["normal","Second paragraph."],
    ]);
  });
});
