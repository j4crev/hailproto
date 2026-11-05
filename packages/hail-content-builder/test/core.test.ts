import {expect,it} from 'vitest';
import {Schema} from '@sanity/schema';
import {toHTML} from '@portabletext/to-html';
import {contentSchema} from '../src/schema.js';
import {fromPortable,toPortable,validateBody,semantics,pngAsset,parseBuilderDraft,assertCapabilities} from '../src/core.js';
import fixture from '../fixtures/text.json';
const text=validateBody(fixture);
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
it('compiles the published Sanity schema and renders the supported text vocabulary',()=>{
  const schema=Schema.compile({name:'hail',types:[contentSchema]});
  expect(schema.get('hailContent').of.map((v:{name:string})=>v.name)).toEqual(['block','hailImage']);
  const html=toHTML(toPortable(text).blocks,{components:{block:{caption:({children})=>`<p>${children}</p>`}}});
  expect(html).toContain('<strong>');expect(html).toContain('&lt;example&gt;');expect(html).toContain('<ul>');expect(html).toContain('<ol>');expect(html).toContain('https://example.invalid/path?private=1');
});
it('round trips text and a bundled asset while permitting editor key and span changes',async()=>{
  const asset=await pngAsset(png);
  const body=validateBody({version:1,profile:'spt-3',assets:{version:1,assets:[asset]},blocks:[{_type:'spt.image',asset:asset.id,alt:'One pixel',caption:'Bundled, never fetched'},...text.blocks]});
  const bundle=toPortable(body);
  bundle.blocks.forEach((b,i)=>b._key=`editor${i}`);
  const result=fromPortable(JSON.parse(JSON.stringify(bundle)));
  expect(semantics(result)).toEqual(semantics(body));
  expect(toPortable(result).assets[0]).toEqual(asset);
  expect(()=>assertCapabilities(result,['spt-2'])).toThrow('Host does not support');
  expect(parseBuilderDraft({version:1,body:result}).body).toEqual(result);
});
it('rejects unsupported or hostile Portable Text with location-aware errors',()=>{
  const cases=[
    (v:any)=>v.blocks[0].html='<script>bad()</script>',
    (v:any)=>v.blocks[0]._type='image',
    (v:any)=>v.blocks[0].children[0].marks=['underline'],
    (v:any)=>v.blocks[1].markDefs[0].href='javascript:alert(1)',
    (v:any)=>v.blocks[1].markDefs[0].href='http://example.invalid',
    (v:any)=>v.blocks[1].markDefs[0].href='https://user:pass@example.invalid',
    (v:any)=>v.blocks[3].level=4,
    (v:any)=>v.blocks[0]._key=v.blocks[1]._key,
    (v:any)=>v.blocks[0].children[0]._type='remoteEmbed',
    (v:any)=>v.blocks[0].children[0].text='a'.repeat(360001),
    (v:any)=>v.assets=[{url:'https://example.invalid/tracker.png'}],
  ];
  for(const mutate of cases){const bundle=toPortable(text);mutate(bundle);expect(()=>fromPortable(bundle)).toThrow();}
});
it('rejects damaged PNGs, digest mismatch, remote references and decomposed image descriptions',async()=>{
  const broken=png.slice();broken[40]^=1;await expect(pngAsset(broken)).rejects.toThrow();
  await expect(pngAsset(new Uint8Array(196609))).rejects.toThrow();
  const asset=await pngAsset(png);
  const body:any={version:1,profile:'spt-3',assets:{version:1,assets:[asset]},blocks:[{_type:'spt.image',asset:asset.id,alt:'One pixel'},...text.blocks]};
  expect(()=>validateBody(body)).not.toThrow();body.blocks[0].alt='e\u0301';expect(()=>validateBody(body)).toThrow();body.blocks[0].alt='One pixel';
  body.assets.assets[0].digest.value='A'.repeat(43);expect(()=>validateBody(body)).toThrow();
});
it('reimports near-limit bodies even when Portable Text editor keys exceed the body JSON budget',()=>{
  const body=validateBody({version:1,profile:'spt-2',blocks:[{_type:'block',style:'normal',markDefs:[],children:Array.from({length:1000},()=>({_type:'span',text:'x'.repeat(315),marks:[]}))}]});
  const bundle=toPortable(body);
  expect(new TextEncoder().encode(JSON.stringify(bundle)).length).toBeGreaterThan(360000);
  expect(semantics(fromPortable(bundle))).toEqual(semantics(body));
});

it('defines semantic equivalence for consistent annotation renaming, mark order and span segmentation',()=>{
  const bundle=toPortable(text),block=bundle.blocks[1] as any;
  block.markDefs[0]._key='editor_link';block.children[1].marks=['code','editor_link'];
  const original=block.children[0];block.children.splice(0,1,{...original,text:'Café ',marks:['em','strong']},{...original,_key:'split',text:'日本語\n'});
  expect(semantics(fromPortable(bundle))).toEqual(semantics(text));
});

it('saves unfinished header descriptions without weakening publication or asset validation',async()=>{
  const body:any={version:1,profile:'spt-3',assets:{version:1,assets:[await pngAsset(png)]},blocks:[{_type:'spt.image',asset:'header',alt:''},...text.blocks]};
  expect(parseBuilderDraft({version:1,body}).body).toEqual(body);
  expect(fromPortable(toPortable(body),{draft:true})).toEqual(body);
  expect(()=>validateBody(body)).toThrow();
  expect(()=>fromPortable(toPortable(body))).toThrow();
  body.assets.assets[0].digest.value='A'.repeat(43);
  expect(()=>parseBuilderDraft({version:1,body})).toThrow();
});
