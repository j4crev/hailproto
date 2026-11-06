import {expect,it,vi} from "vitest";
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock("$lib/server/canary.js",()=>({canaryAccount:async()=>({client:{request}})}));
import {actions} from "../routes/compose/+page.server.js";

const id="019a15fd-2bd0-7433-8afa-bd0355e0608d";
const targetId="019a15fd-2bd0-7433-8afa-bd0355e0608e";
for(const kind of ["category","connections"] as const){
  const accepted=()=>({publicationId:id,category:kind==="category"?"general":null,...(kind==="connections"?{kind}:{}),total:1,state:"publishing",
    counts:{pending:1,submitted:0,blocked:0,cancelled:0,expired:0,indeterminate:0},
    delivery:{accepted:0,delivered:0,"on-hold":0,failed:0,cancelled:0,indeterminate:0},
    targets:[{messageId:targetId,recipient:"did:plc:"+"a".repeat(24),state:"pending",delivery:null}],
    createdAt:"2026-10-24T00:00:00Z",expiresAt:"2026-10-25T00:00:00Z"});
  const publish=()=>{
    const body=new FormData();
    for(const [key,value] of Object.entries({publicationId:id,audience:kind,text:"Hello",
      ...(kind==="category"?{category:"general"}:{connection:targetId})}))body.set(key,value);
    return actions.publish({request:new Request("https://example.com/compose",{method:"POST",body}),cookies:{get:()=>undefined,getAll:()=>[],set:vi.fn(),delete:vi.fn(),serialize:()=>""},url:new URL("https://example.com/compose")} as unknown as Parameters<typeof actions.publish>[0]);
  };
  it(`${kind}: acknowledges provider acceptance while all recipients are still pending`,async()=>{
    request.mockReset();
    request.mockResolvedValueOnce(accepted());
    await expect(publish()).rejects.toMatchObject({status:303,location:`/compose?${kind==="connections"?"audience=connections&":""}publication=${id}`});
    expect(request.mock.calls[0]).toMatchObject([kind==="connections"?"/connection-messages":"/publications",{
      body:{version:1,profile:"spt-2",blocks:[{_type:"block",children:[{_type:"span",text:"Hello",marks:[]}]}]},
    }]);
    expect(request.mock.calls[0][1]).not.toHaveProperty("text");
    if(kind==="connections")expect(request.mock.calls[0][1].delivery).toBe("private");
  });
  it(`${kind}: does not acknowledge a lost or mismatched provider response`,async()=>{
    request.mockRejectedValueOnce(new Error("Response lost"));
    expect(await publish()).toMatchObject({status:502,data:{publicationId:id,error:expect.any(String)}});
    request.mockResolvedValueOnce({...accepted(),publicationId:targetId});
    expect(await publish()).toMatchObject({status:502,data:{publicationId:id,error:expect.any(String)}});
  });
}

it('forwards an authenticated inbox source only through connection sends',async()=>{
  request.mockReset();
  const body=new FormData();
  const sender='did:plc:'+'a'.repeat(24);
  for(const [key,value] of Object.entries({publicationId:id,audience:'connections',text:'',connection:targetId,forwardSender:sender,forwardMessage:id}))body.set(key,value);
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body}),cookies:{},url:new URL('https://example.com/compose')} as unknown as Parameters<typeof actions.publish>[0]);
  request.mockResolvedValueOnce({sender,messageId:id,recipient:'did:plc:'+'b'.repeat(24),category:'general',deliveredAt:'2026-10-29T00:00:00Z',body:{version:1,profile:'spt-1',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'Original message',marks:[]}],markDefs:[]}]}});
  request.mockRejectedValueOnce(new Error('Response lost'));
  expect(await publish()).toMatchObject({status:502,data:{publicationId:id}});
  expect(request.mock.calls[0][0]).toBe(`/inbox/${encodeURIComponent(sender)}/${id}`);
  expect(request.mock.calls[1]).toMatchObject(['/connection-messages',{publicationId:id,connections:[targetId],body:{profile:'spt-2'}}]);
  expect(JSON.stringify(request.mock.calls[1][1])).toContain('Original message');
  expect(request.mock.calls[1][1]).not.toHaveProperty('replyTo');
  request.mockClear();
  body.set('audience','category');body.set('category','general');body.delete('connection');
  expect(await publish()).toMatchObject({status:400});
  expect(request).not.toHaveBeenCalled();
});

it('does not send when the forward source is missing',async()=>{
  request.mockReset();request.mockRejectedValueOnce(new Error('Not found'));
  const body=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,audience:'connections',text:'Note',connection:targetId,forwardSender:'did:plc:'+'a'.repeat(24),forwardMessage:id}))body.set(key,value);
  expect(await actions.publish({request:new Request('https://example.com/compose',{method:'POST',body}),cookies:{},url:new URL('https://example.com/compose')} as unknown as Parameters<typeof actions.publish>[0])).toMatchObject({status:400});
  expect(request).toHaveBeenCalledTimes(1);
});

it('limits new header uploads to subscribers while retaining rich connection text',async()=>{
  const body=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,audience:'connections',title:'Hello',text:'**Rich text**',connection:targetId,alt:'A small image'}))body.set(key,value);
  body.set('header',new File([Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ6kAAAAASUVORK5CYII=','base64'))],'header.png',{type:'image/png'}));
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body}),cookies:{},url:new URL('https://example.com/compose')} as unknown as Parameters<typeof actions.publish>[0]);
  request.mockReset();
  expect(await publish()).toMatchObject({status:400,data:{error:'Images are available for subscriber publications only.'}});
  expect(request).not.toHaveBeenCalled();
  body.set('audience','category');body.set('category','general');body.delete('connection');
  request.mockRejectedValueOnce(new Error('Response lost'));
  await publish();
  expect(request.mock.calls[0]).toMatchObject(['/publications',{body:{profile:'spt-3'}}]);
  body.set('audience','connections');body.set('connection',targetId);body.delete('category');body.delete('header');
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  await publish();
  expect(request.mock.calls[0]).toMatchObject(['/connection-messages',{body:{profile:'spt-2'}}]);
});

it('hands validated builder content to the existing publication flow without Markdown conversion',async()=>{
  const body={version:1,profile:'spt-2',blocks:[{_type:'block',style:'h2',children:[{_type:'span',text:'Literal **asterisks**',marks:['strong','em']}],markDefs:[]}]};
  const form=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,draftRevision:'4',audience:'category',category:'general',builder:JSON.stringify({version:1,body})}))form.set(key,value);
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never);
  expect(await publish()).toMatchObject({status:502,data:{publicationId:id}});
  expect(request).toHaveBeenCalledWith('/publications',expect.objectContaining({draftRevision:4,body}));
  request.mockReset();form.set('text','Competing text');expect(await publish()).toMatchObject({status:400});expect(request).not.toHaveBeenCalled();
  form.delete('text');form.set('builder',JSON.stringify({version:1,body:{...body,blocks:[{...body.blocks[0],html:'<img src="https://tracker.invalid">'}]}}));
  expect(await publish()).toMatchObject({status:400});expect(request).not.toHaveBeenCalled();
});

it('publishes ordered inline images and rejects any unfinished image description',async()=>{
  const {pngAsset}=await import('@racrproto/content-builder/core');
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
  const assets=[await pngAsset(png,true),await pngAsset(png,true)];
  const text={_type:'block',style:'normal',children:[{_type:'span',text:'Newsletter',marks:[]}],markDefs:[]};
  const body={version:1,profile:'spt-3',assets:{version:1,assets},blocks:[text,{_type:'spt.image',asset:assets[0].id,alt:'First'},text,{_type:'spt.image',asset:assets[1].id,alt:'Second'}]};
  const form=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,audience:'category',category:'general',builder:JSON.stringify({version:1,body})}))form.set(key,value);
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never);
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  expect(await publish()).toMatchObject({status:502});
  expect(request).toHaveBeenCalledWith('/publications',expect.objectContaining({body}));
  const last=body.blocks[3]!;if(!('alt' in last))throw Error('Expected image');last.alt='';form.set('builder',JSON.stringify({version:1,body}));request.mockReset();
  expect(await publish()).toMatchObject({status:400});expect(request).not.toHaveBeenCalled();
});

it('hands off aligned CTA content unchanged and keeps unfinished destinations in drafts only',async()=>{
  const body={version:1,profile:'spt-2',blocks:[{_type:'block',style:'cta',alignment:'center',children:[{_type:'span',text:'Register now',marks:['action']}],markDefs:[{_type:'spt.link',_key:'action',href:'https://example.invalid/register'}]}]};
  const form=new FormData();
  for(const [key,value] of Object.entries({publicationId:id,audience:'category',category:'general',builder:JSON.stringify({version:1,body})}))form.set(key,value);
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never);
  request.mockReset();request.mockRejectedValueOnce(new Error('Response lost'));
  expect(await publish()).toMatchObject({status:502});
  expect(request).toHaveBeenCalledWith('/publications',expect.objectContaining({body}));
  for(const href of ['','http://example.invalid','javascript:alert(1)']){
    body.blocks[0].markDefs[0].href=href;form.set('builder',JSON.stringify({version:1,body}));request.mockReset();
    expect(await publish()).toMatchObject({status:400});expect(request).not.toHaveBeenCalled();
  }
});

it('rejects Connection builder payloads while keeping basic formatting on ordinary messages',async()=>{
  const form=new FormData();
  const body={version:1,profile:'spt-2',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'Block content',marks:[]}],markDefs:[]}]};
  for(const [key,value] of Object.entries({publicationId:id,audience:'connections',connection:targetId,builder:JSON.stringify({version:1,body})}))form.set(key,value);
  const publish=()=>actions.publish({request:new Request('https://example.com/compose',{method:'POST',body:form}),cookies:{},url:new URL('https://example.com/compose')} as never);
  request.mockReset();expect(await publish()).toMatchObject({status:400,data:{error:'The block builder is available for subscriber publications only.'}});expect(request).not.toHaveBeenCalled();
  form.delete('builder');form.set('text','**Bold** and *italic* [Link](https://example.invalid)\n\n- Item');
  request.mockRejectedValueOnce(new Error('Response lost'));await publish();
  const submitted=request.mock.calls[0][1].body;
  expect(submitted.blocks[0].children).toEqual(expect.arrayContaining([expect.objectContaining({text:'Bold',marks:['strong']}),expect.objectContaining({text:'italic',marks:['em']})]));
  expect(submitted.blocks[0].markDefs[0].href).toBe('https://example.invalid/');
  expect(submitted.blocks[1].listItem).toBe('bullet');
});
