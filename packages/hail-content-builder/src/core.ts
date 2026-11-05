import {encodePayload, fromDiagnosticJson, encodeBase64Url, validatePngStructure, type DiagnosticJson, type HailSpt2TextBlock} from '@racrproto/codec/content';

export type TextBlock = HailSpt2TextBlock;
export type HeaderAsset = {id:string;role:'header';media_type:'image/png';loading:'bundled';size:number;digest:{algorithm:'sha-256';value:string};width:number;height:number;data:string};
export type ImageBlock = {_type:'spt.image';asset:string;alt:string;caption?:string};
export type BuilderBody = {version:1;profile:'spt-2';blocks:TextBlock[]} | {version:1;profile:'spt-3';blocks:[ImageBlock,...TextBlock[]];assets:{version:1;assets:[HeaderAsset]}};
export type BuilderDraft = {version:1;body:BuilderBody};
export type PortableBlock = Record<string,unknown> & {_type:string;_key:string};
export type PortableBundle = {version:1;blocks:PortableBlock[];assets:HeaderAsset[]};
export type Diagnostic = {path:string;code:string;message:string};
export const emptyBody = ():BuilderBody => ({version:1,profile:'spt-2',blocks:[]});
const budget = (value:unknown,maximum=360000) => {if(new TextEncoder().encode(JSON.stringify(value)).length>maximum)throw new Error(`Content exceeds the ${maximum.toLocaleString('en-US')}-byte budget.`);};
function object(value:unknown,path:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${path}: expected an object`);
  return value as Record<string,unknown>;
}
function fields(value:Record<string,unknown>,allowed:string[],path:string){
  for(const key of Object.keys(value))if(!allowed.includes(key))throw new Error(`${path}.${key}: unsupported field; remove it before importing`);
}
export function validateBody(value:unknown):BuilderBody {
  budget(value);
  const v=object(value,'body');
  if(v.profile!=='spt-2'&&v.profile!=='spt-3')throw new Error('body.profile: this builder supports spt-2 and spt-3');
  // Attachments belong to the host publication flow, never the editor document.
  fields(v,['version','profile','blocks',...(v.profile==='spt-3'?['assets']:[])],'body');
  const type=v.profile==='spt-3'?'hail.body.spt-3':'hail.body.spt-2';
  encodePayload(type,fromDiagnosticJson(type,v as DiagnosticJson));
  return JSON.parse(JSON.stringify(v)) as BuilderBody;
}
/** Drafts may retain an empty header description; published bodies may not. */
export function validateDraftBody(value:unknown):BuilderBody {
  budget(value);
  const candidate=JSON.parse(JSON.stringify(object(value,'body')));
  const first=Array.isArray(candidate.blocks)?candidate.blocks[0]:undefined;
  if(candidate.profile==='spt-3'&&first?._type==='spt.image'&&first.alt===''){
    // Validate every other field through the codec, then preserve the unfinished value.
    first.alt='x';
    const body=validateBody(candidate);
    if(body.profile==='spt-3')body.blocks[0].alt='';
    return body;
  }
  return validateBody(value);
}
export function parseBuilderDraft(value:unknown):BuilderDraft {
  const v=object(value,'builder');fields(v,['version','body'],'builder');
  if(v.version!==1)throw new Error('builder.version: unsupported draft version');
  return {version:1,body:validateDraftBody(v.body)};
}
export function diagnostics(error:unknown):Diagnostic[] {
  const e=error as {path?:string;code?:string;message?:string};
  return [{path:e?.path??'document',code:e?.code??'unsupported-content',message:e?.message??'Invalid content'}];
}
export function textBlocks(body:BuilderBody):TextBlock[] {return (body.profile==='spt-3'?body.blocks.slice(1):body.blocks) as TextBlock[];}
export function plainText(body:BuilderBody){return textBlocks(body).map(b=>b.children.map(s=>s.text).join('')).join('\n');}
export function assertCapabilities(body:BuilderBody,profiles:readonly string[]){
  if(!profiles.includes(body.profile))throw new Error(`Host does not support ${body.profile}. Remove the header or choose a supporting host.`);
}
export function toPortable(body:BuilderBody):PortableBundle {
  const valid=validateDraftBody(body);
  return {version:1,assets:valid.profile==='spt-3'?structuredClone(valid.assets.assets):[],blocks:valid.blocks.map((block,index)=>{
    if(block._type==='spt.image')return {...block,_type:'hailImage',_key:`b${index}`};
    return {...block,_key:`b${index}`,children:block.children.map((span,i)=>({...span,_key:`s${i}`})),markDefs:block.markDefs.map(def=>({...def,_type:'link'}))};
  })};
}
export function fromPortable(value:unknown,options:{draft?:boolean}={}):BuilderBody {
  budget(value,1000000);
  const bundle=object(value,'bundle');fields(bundle,['version','blocks','assets'],'bundle');
  if(bundle.version!==1||!Array.isArray(bundle.blocks)||!Array.isArray(bundle.assets))throw new Error('Expected a version 1 Portable Text bundle with blocks and bundled assets');
  const seen=new Set<string>();
  const key=(v:Record<string,unknown>,set:Set<string>,path:string)=>{if(typeof v._key!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(v._key)||set.has(v._key))throw new Error(`${path}._key: supply a unique stable key`);set.add(v._key);};
  const blocks=bundle.blocks.map((entry,index)=>{
    const path=`blocks[${index}]`,v=object(entry,path);key(v,seen,path);
    if(v._type==='hailImage'){
      fields(v,['_type','_key','asset','alt','caption'],path);
      const {_key,...image}=v;return {...image,_type:'spt.image'};
    }
    if(v._type!=='block')throw new Error(`${path}._type: unsupported ${String(v._type)}; only text and the bundled header are supported`);
    fields(v,['_type','_key','style','listItem','level','children','markDefs'],path);
    if(!Array.isArray(v.children)||!Array.isArray(v.markDefs))throw new Error(`${path}: children and markDefs must be arrays`);
    const childKeys=new Set<string>();
    const children=v.children.map((entry,i)=>{
      const child=object(entry,`${path}.children[${i}]`);fields(child,['_type','_key','text','marks'],`${path}.children[${i}]`);key(child,childKeys,`${path}.children[${i}]`);
      const {_key,...span}=child;return span;
    });
    const markDefs=v.markDefs.map((entry,i)=>{
      const def=object(entry,`${path}.markDefs[${i}]`);fields(def,['_key','_type','href','title'],`${path}.markDefs[${i}]`);
      if(def._type!=='link')throw new Error(`${path}.markDefs[${i}]: only link annotations are supported`);
      return {...def,_type:'spt.link'};
    });
    const {_key,...block}=v;return {...block,children,markDefs};
  });
  return (options.draft?validateDraftBody:validateBody)(bundle.assets.length?{version:1,profile:'spt-3',blocks,assets:{version:1,assets:bundle.assets}}:{version:1,profile:'spt-2',blocks});
}
export async function pngAsset(data:Uint8Array):Promise<HeaderAsset> {
  if(data.length>196608)throw new Error('Choose a PNG up to 192 KiB.');
  const {width,height}=validatePngStructure(data);
  if(width>2400||height>1200||width*height>2000000)throw new Error('Header must fit 2400 × 1200 and 2,000,000 pixels.');
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(data)));
  return {id:'header',role:'header',media_type:'image/png',loading:'bundled',size:data.length,digest:{algorithm:'sha-256',value:encodeBase64Url(digest)},width,height,data:encodeBase64Url(data)};
}
/** Semantic equality ignores editor identity, annotation keys, span segmentation and mark order.
 * Text itself is exact (including Unicode and line breaks); assets remain byte-identical. */
export function semantics(body:BuilderBody):unknown {
  return {assets:body.profile==='spt-3'?body.assets:null,blocks:body.blocks.map(block=>{
    if(block._type==='spt.image')return block;
    const runs:{text:string;marks:string[]}[]=[];
    for(const span of block.children){
      const marks=span.marks.map(mark=>{const def=block.markDefs.find(d=>d._key===mark);return def?JSON.stringify({href:def.href,title:def.title??null}):mark;}).sort();
      const last=runs.at(-1);if(last&&JSON.stringify(last.marks)===JSON.stringify(marks))last.text+=span.text;else if(span.text)runs.push({text:span.text,marks});
    }
    return {style:block.style,listItem:block.listItem??null,level:block.listItem?(block.level??1):null,runs};
  })};
}

/** In-process host contract v1. Hosts own persistence, revision CAS, audience and publication. */
export interface BuilderHost {
  version:1;
  profiles:readonly ('spt-2'|'spt-3')[];
  initial:BuilderDraft;
  revision:number;
  save(draft:BuilderDraft,expectedRevision:number):Promise<{revision:number}>;
  handoff(draft:BuilderDraft):void;
  change?(draft:BuilderDraft|null,issues:Diagnostic[]):void;
}
