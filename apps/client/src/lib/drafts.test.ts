import {expect,it,vi} from 'vitest';
import {parseDraftContent} from '@racrproto/client-support/drafts';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('$lib/server/canary.js',()=>({canaryAccount:async()=>({account:{address:'me@example.com'},client:{request}})}));
import {actions,load} from '../routes/compose/+page.server.js';
const id='019a0000-0000-7000-8000-000000000001';
const content={audience:'category',category:'',connections:[],title:'',text:'',alt:'',caption:'',allowReply:false,header:null,forward:null};
it('permits incomplete drafts but rejects oversized and incompatible content',()=>{
  expect(parseDraftContent(content)).toEqual(content);
  for(const changes of [{text:'x'.repeat(65537)},{title:'é'.repeat(65)},{audience:'connections',header:'iVBORw0KGgo'},{forward:{sender:'untrusted',messageId:id}},{extra:true}])expect(()=>parseDraftContent({...content,...changes})).toThrow();
});
it('saves unfinished compose fields and resumes them on a new device',async()=>{
  request.mockReset();
  const saved={id,revision:1,content,updatedAt:'2026-11-03T00:00:00Z',trashedAt:null};
  request.mockResolvedValueOnce(saved);
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'0',audience:'category',text:'',title:''}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(request).toHaveBeenCalledWith(`/drafts/${id}/save`,{revision:0,content});
  request.mockReset();request.mockResolvedValueOnce(saved).mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved,newPublicationId:id,kind:'category'});
});

import vectors from '../../../../spec/vectors/provider-drafts.json';
it('conforms to the provider draft content vectors',()=>{
  for(const example of vectors.valid)expect(parseDraftContent(example.content),example.name).toEqual(example.content);
  for(const example of vectors.invalid)expect(()=>parseDraftContent(example.content),example.name).toThrow();
});

it('sends a resumed PNG and draft revision without requiring a new file selection',async()=>{
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  const form=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,draftRevision:'3',audience:'category',category:'general',title:'Headline',text:'Updated text',alt:'One pixel',savedHeader:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8_x8AAwMCAO-aQ6kAAAAASUVORK5CYII'}))form.set(key,value);
  expect(await actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({status:502,data:{publicationId:id}});
  expect(request).toHaveBeenCalledWith('/publications',expect.objectContaining({publicationId:id,draftRevision:3,body:expect.objectContaining({profile:'spt-3',assets:expect.objectContaining({assets:[expect.objectContaining({width:1,height:1})]})})}));
});

it('saves and resumes rich drafts without converting them to simple compose text',async()=>{
  request.mockReset();
  const builder={version:1,body:{version:1,profile:'spt-2',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'**Literal**',marks:['em','strong']}],markDefs:[]}]}};
  const saved={id,revision:2,content:{...content,builder},updatedAt:'2026-11-04T00:00:00Z',trashedAt:null};
  request.mockResolvedValueOnce(saved);
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'1',audience:'category',builder:JSON.stringify(builder)}))form.set(key,value);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(request).toHaveBeenCalledWith(`/drafts/${id}/save`,{revision:1,content:{...content,builder}});
  request.mockReset();request.mockResolvedValueOnce(saved).mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved});
});

it('saves and resumes an unfinished builder header but rejects publishing it',async()=>{
  const incomplete=vectors.valid.find(v=>v.name==='builder-unfinished-header-description')!.content;
  const saved={id,revision:1,content:incomplete,updatedAt:'2026-11-05T00:00:00Z',trashedAt:null};
  const form=new FormData();for(const [key,value] of Object.entries({publicationId:id,draftRevision:'0',audience:'category',category:'general',builder:JSON.stringify(incomplete.builder)}))form.set(key,value);
  request.mockReset();request.mockResolvedValueOnce(saved);
  expect(await actions.save({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toEqual({savedDraft:saved});
  expect(request).toHaveBeenCalledWith(`/drafts/${id}/save`,{revision:0,content:{...incomplete,category:'general'}});
  request.mockReset();request.mockResolvedValueOnce(saved).mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved});
  request.mockReset();
  expect(await actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({status:400});
  expect(request).not.toHaveBeenCalled();
});

it('loads the builder by default and falls back without writing an unconvertible legacy draft',async()=>{
  request.mockReset();request.mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL('https://example.com/compose')} as never)).toMatchObject({builderInitial:{version:1,body:{version:1,profile:'spt-2',blocks:[]}},builderFallback:false});
  const saved={id,revision:3,content:{...content,header:'iVBORw0KGgo',text:'Keep this'},updatedAt:'2026-11-05T00:00:00Z',trashedAt:null};
  request.mockReset();request.mockResolvedValueOnce(saved).mockResolvedValueOnce({maxRecipients:100,categories:[]});
  expect(await load({cookies:{},url:new URL(`https://example.com/compose?draft=${id}`)} as never)).toMatchObject({draft:saved,builderInitial:null,builderFallback:true});
  expect(request.mock.calls).toEqual([[`/drafts/${id}`],['/publications/audiences']]);
});
