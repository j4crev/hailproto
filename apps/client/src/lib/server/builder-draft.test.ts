import {expect,it} from 'vitest';
import {builderDraft} from './builder-draft.js';
import {composeBlocks} from '../compose.js';
import {parseDraftContent} from '@racrproto/client-support/drafts';
const base=parseDraftContent({audience:'category',category:'general',connections:[],title:'Headline',text:'Hello **world**\n- Item\n[Link](https://example.com)',alt:'',caption:'',allowReply:true,header:null,forward:null});
it('starts new messages empty and converts the old rendered semantics without mutating stored fields',async()=>{
  expect(await builderDraft()).toEqual({version:1,body:{version:1,profile:'spt-2',blocks:[]}});
  const content=structuredClone(base),before=structuredClone(content);
  expect((await builderDraft(content)).body).toEqual({version:1,profile:'spt-2',blocks:composeBlocks(base.title,base.text)});
  expect(content).toEqual(before);
});
it('retains header bytes, caption, and unfinished description when converting',async()=>{
  const header='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk-A8AAQUBAScY42YAAAAASUVORK5CYII';
  const result=await builderDraft({...base,header,caption:'My caption'});
  expect(result.body).toMatchObject({profile:'spt-3',blocks:[{_type:'spt.image',asset:'header',alt:'',caption:'My caption'},...composeBlocks(base.title,base.text)],assets:{assets:[{data:header}]}});
});
it('does not reinterpret existing rich text and refuses lossy conversion of unsupported drafts',async()=>{
  const builder=await builderDraft({...base,text:'Literal **stars**'});
  expect(await builderDraft({...base,builder})).toEqual(builder);
  await expect(builderDraft({...base,header:'iVBORw0KGgo'})).rejects.toThrow();
  await expect(builderDraft({...base,alt:'e\u0301',header:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk-A8AAQUBAScY42YAAAAASUVORK5CYII'})).rejects.toThrow();
  await expect(builderDraft({...base,forward:{sender:'did:plc:'+'a'.repeat(24),messageId:'019a0000-0000-7000-8000-000000000001'}})).rejects.toThrow();
});
