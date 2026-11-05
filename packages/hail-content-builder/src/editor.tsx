import React from 'react';
import {createPortal} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {EditorProvider, PortableTextEditable, defineSchema, defineTextBlock, defineBlockObject, defineDecorator, defineAnnotation, useEditor, useEditorSelector, type PortableTextBlock, type EditorEvent} from '@portabletext/editor';
import {EventListenerPlugin, NodePlugin} from '@portabletext/editor/plugins';
import {getValue, getFocusBlock, getActiveStyle, isActiveDecorator, getActiveListItem} from '@portabletext/editor/selectors';
import {pngAsset,type PortableBlock,type HeaderAsset} from './core.js';

export const schemaDefinition=defineSchema({
  block:{fields:[{name:'alignment',type:'string'}]},
  styles:['normal','h1','h2','h3','blockquote','caption'].map(name=>({name})),
  decorators:['strong','em','code'].map(name=>({name})),lists:[{name:'bullet'},{name:'number'}],
  annotations:[{name:'link',fields:[{name:'href',type:'string'},{name:'title',type:'string'}]}],
  inlineObjects:[],blockObjects:[{name:'hailCta',fields:[{name:'label',type:'string'},{name:'href',type:'string'},{name:'title',type:'string'},{name:'alignment',type:'string'}]},{name:'hailImage',fields:[{name:'asset',type:'string'},{name:'alt',type:'string'},{name:'caption',type:'string'}]}],
});
const ObjectSelection=React.createContext<{key:string|null;select:(key:string|null)=>void}>({key:null,select:()=>{}});
function ObjectSelectionProvider({children}:{children:React.ReactNode}){
  const editor=useEditor(),focus=useEditorSelector(editor,getFocusBlock);
  const [key,select]=React.useState<string|null>(null);
  React.useEffect(()=>{if(focus)select(focus.node._key);},[focus?.node._key]);
  return <ObjectSelection.Provider value={{key,select}}>{children}</ObjectSelection.Provider>;}
const Assets=React.createContext(new Map<string,HeaderAsset>());
type NoticeKind='error'|'info';
const Notify=React.createContext<(message:string,kind?:NoticeKind)=>void>(()=>{});
function isHeaderBlock(block:PortableTextBlock|undefined,assets:Map<string,HeaderAsset>){return block?._type==='hailImage'&&'asset' in block&&assets.get(String(block.asset))?.role==='header';}
const Dragged=React.createContext<{key:string|null}>({key:null});
function BlockFrame({id,children}:{id:string;children:React.ReactNode}){
  const editor=useEditor(),drag=React.useContext(Dragged),assets=React.useContext(Assets),selection=React.useContext(ObjectSelection);
  const value=useEditorSelector(editor,getValue);
  const focus=useEditorSelector(editor,getFocusBlock);
  const selected=(focus?.node._key??selection.key)===id;
  const pinned=isHeaderBlock(value.find(block=>block._key===id),assets);
  const [over,setOver]=React.useState<'before'|'after'|null>(null);
  return <div className={'builder-block'+(selected?' is-selected':'')+(over?' drop-'+over:'')} data-block-key={id}
    onMouseDownCapture={()=>selection.select(id)} onFocusCapture={()=>selection.select(id)}
    onDragOver={event=>{if(drag.key){event.preventDefault();event.stopPropagation();if(pinned||drag.key===id)return;const blocks=getValue(editor.getSnapshot());setOver(blocks.findIndex(block=>block._key===drag.key)<blocks.findIndex(block=>block._key===id)?'after':'before');}}}
    onDragLeave={()=>setOver(null)} onDrop={event=>{if(!drag.key)return;event.preventDefault();event.stopPropagation();setOver(null);if(!pinned&&drag.key!==id)editor.send({type:'move.block',at:[{_key:drag.key}],to:[{_key:id}]});drag.key=null;}}>
    <button type="button" className="builder-drag" contentEditable={false} draggable={!pinned} aria-label={pinned?'Select Feed header':'Drag block to reorder'} title={pinned?'Feed header stays at the top. Uncheck Use as Feed header to move it.':'Drag to reorder; use Block actions to move with the keyboard'}
      onMouseDown={e=>e.stopPropagation()} onClick={()=>{selection.select(id);editor.send({type:'select.block',at:[{_key:id}]});}}
      onDragStart={event=>{event.stopPropagation();if(pinned){event.preventDefault();return;}drag.key=id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',id);}}
      onDragEnd={()=>{drag.key=null;setOver(null);}}><svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true"><path d="M6 4h1m4 0h1M6 10h1m4 0h1M6 16h1m4 0h1" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg></button>{children}
  </div>;
}
function ImageContent({node,settings=false}:{node:PortableBlock;settings?:boolean}){
  const editor=useEditor(),assets=React.useContext(Assets),asset=assets.get(String(node.asset)),notify=React.useContext(Notify);
  const isHeader=asset?.role==='header';
  function changeRole(header:boolean){
    if(!asset)return;
    if(header&&asset.height>1200){notify('Feed headers must be at most 2400 × 1200 pixels. Keep this portrait inline or choose a shorter image.');return;}
    const setRole=(block:PortableBlock,role:'header'|'image')=>{
      const original=assets.get(String(block.asset));if(!original)return;
      const id=role+'-'+crypto.randomUUID();assets.set(id,{...original,id,role});
      editor.send({type:'block.set',at:[{_key:block._key}],props:{asset:id}});
    };
    if(header){
      const blocks=getValue(editor.getSnapshot()) as PortableBlock[];
      for(const block of blocks)if(block._key!==node._key&&block._type==='hailImage'&&assets.get(String(block.asset))?.role==='header')setRole(block,'image');
      if(blocks[0]?._key!==node._key)editor.send({type:'move.block',at:[{_key:node._key}],to:[{_key:blocks[0]!._key}]});
    }
    setRole(node,header?'header':'image');
  }
  const update=(field:'alt'|'caption',value:string)=>{
    if(field==='caption'&&!value)editor.send({type:'block.unset',at:[{_key:node._key}],props:['caption']});
    else editor.send({type:'block.set',at:[{_key:node._key}],props:{[field]:value.normalize('NFC')}});
  };
  if(!settings)return <div className="builder-image" contentEditable={false}>
    {asset&&<img src={'data:image/png;base64,'+asset.data.replaceAll('-','+').replaceAll('_','/')} alt={String(node.alt??'')} width={asset.width} height={asset.height}/>}
    {!!node.caption&&<div className="builder-image-caption">{String(node.caption)}</div>}
  </div>;
  return <div className="builder-image-fields" onMouseDown={e=>e.stopPropagation()}>
      {isHeader&&<><strong className="builder-header-label">Feed header</strong><p className="builder-image-help">Featured in the Feed and at the top of your message.</p></>}
      <label>Image description<input aria-label="Image description" value={String(node.alt??'')} aria-required="true" aria-describedby={!node.alt?`description-help-${node._key}`:undefined} maxLength={1024} placeholder="Describe this image for readers" onChange={e=>update('alt',e.target.value)}/></label>
      {!node.alt&&<p id={`description-help-${node._key}`} className="builder-image-help">Add a description of the image before sending.</p>}
      <label>Caption <span>(optional)</span><input aria-label="Image caption" value={String(node.caption??'')} maxLength={1024} onChange={e=>update('caption',e.target.value)}/></label>
      <div className="builder-image-actions"><label className="builder-header-option"><input type="checkbox" checked={isHeader} onChange={event=>changeRole(event.target.checked)}/> Use as Feed header</label>
      <button type="button" onClick={()=>editor.send({type:'delete.block',at:[{_key:node._key}]})}>Remove image</button></div>
    </div>;
}
// A form-like editing projection; the public Portable Text bundle stays a standard
// text block with cta style and one link annotation. No UI-only fields reach SPT.
function editorBlock(block:PortableBlock):PortableBlock {
  if(block._type!=='block'||block.style!=='cta')return block;
  const spans=block.children as {text:string}[],link=(block.markDefs as {href:string;title?:string}[])[0];
  return {_type:'hailCta',_key:block._key,label:spans.map(span=>span.text).join(''),href:link.href,...(link.title===undefined?{}:{title:link.title}),...(block.alignment===undefined?{}:{alignment:block.alignment})};
}
function portableBlock(block:PortableBlock):PortableBlock {
  if(block._type!=='hailCta')return block;
  return {_type:'block',_key:block._key,style:'cta',...(block.alignment===undefined?{}:{alignment:block.alignment}),children:[{_type:'span',_key:'label',text:block.label,marks:['ctaLink']}],markDefs:[{_type:'link',_key:'ctaLink',href:block.href,...(block.title===undefined?{}:{title:block.title})}]};
}
function CallToAction({node,settings=false}:{node:PortableBlock;settings?:boolean}){
  const editor=useEditor(),selection=React.useContext(ObjectSelection);
  const label=String(node.label??''),href=String(node.href??'');
  const update=(field:'label'|'href',value:string)=>{selection.select(node._key);editor.send({type:'block.set',at:[{_key:node._key}],props:{[field]:value}});};
  const alignment=['left','center','right'].includes(String(node.alignment))?node.alignment as 'left'|'center'|'right':'left';
  if(!settings)return <div className="builder-cta" contentEditable={false}>
    <div className="builder-cta-preview" style={{textAlign:alignment}}><span>{label||'Call to action'}</span></div>
  </div>;
  return <div className="builder-image-fields" onMouseDown={event=>event.stopPropagation()}>
      <label>Button label<input aria-label="Button label" maxLength={128} value={label} placeholder="e.g. Register now" onChange={event=>update('label',event.target.value)} onFocus={()=>selection.select(node._key)}/></label>
      <label>Destination<input aria-label="Call-to-action destination" inputMode="url" maxLength={2048} value={href} placeholder="https://" onChange={event=>update('href',event.target.value)} onFocus={()=>selection.select(node._key)}/></label>
    </div>;
}
function Inspector(){
  const editor=useEditor(),selection=React.useContext(ObjectSelection);
  const focus=useEditorSelector(editor,getFocusBlock),blocks=useEditorSelector(editor,getValue);
  const node=blocks.find(block=>block._key===(focus?.node._key??selection.key)) as PortableBlock|undefined;
  return <aside className="builder-inspector" aria-label="Block settings">
    <h3>{node?._type==='hailImage'?'Image settings':node?._type==='hailCta'?'Button settings':'Block settings'}</h3>
    {node?._type==='hailImage'?<ImageContent key={node._key} node={node} settings/>:node?._type==='hailCta'?<CallToAction key={node._key} node={node} settings/>:<p className="builder-inspector-hint">{node?'Edit text on the canvas. Use the toolbar to change its style and alignment.':'Select a block to edit its settings.'}</p>}
  </aside>;
}
function SettingsPanel({target,element}:{target:HTMLElement;element:HTMLElement}){
  const [wide,setWide]=React.useState(false),dialog=React.useRef<HTMLDialogElement>(null);
  const selection=React.useContext(ObjectSelection),editor=useEditor();
  React.useEffect(()=>{
    function edit(event:Event){
      const index=(event as CustomEvent<number>).detail,block=getValue(editor.getSnapshot())[index];if(!block)return;
      selection.select(block._key);editor.send({type:'select.block',at:[{_key:block._key}]});
      requestAnimationFrame(()=>{
        const frame=Array.from(element.querySelectorAll<HTMLElement>('[data-block-key]')).find(node=>node.dataset.blockKey===block._key);
        frame?.scrollIntoView({block:'center'});
        if(!wide)dialog.current?.showModal();
        requestAnimationFrame(()=>{const panel=wide?target:dialog.current;panel?.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true});});
      });
    }
    element.addEventListener('builder:edit-block',edit);return ()=>element.removeEventListener('builder:edit-block',edit);
  },[editor,element,target,wide,selection.select]);
  React.useEffect(()=>{
    const layout=target.parentElement!;
    const observer=new ResizeObserver(()=>{const next=layout.clientWidth>=1000;layout.dataset.builderWide=String(next);setWide(next);if(next)dialog.current?.close();});
    observer.observe(layout);return ()=>{observer.disconnect();delete layout.dataset.builderWide;};
  },[target]);
  function close(){dialog.current?.close();const block=Array.from(element.querySelectorAll<HTMLElement>('[data-block-key]')).find(block=>block.dataset.blockKey===selection.key);block?.querySelector<HTMLButtonElement>('.builder-drag')?.focus({preventScroll:true});}
  return <>{wide?createPortal(<div className="hail-builder-ui"><Inspector/></div>,target):<>
    <button className="builder-settings-launch" type="button" onClick={()=>dialog.current?.showModal()}>Block settings</button>
    <dialog ref={dialog} className="hail-builder-ui builder-sheet" aria-label="Block settings" onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===dialog.current){const r=dialog.current.getBoundingClientRect();if(event.clientY<r.top||event.clientX<r.left||event.clientX>r.right)close();}}}>
      <button type="button" className="builder-sheet-close" onClick={close}>Done</button><Inspector/>
    </dialog>
  </>}</>;
}
const nodes=[defineTextBlock({type:'block',render:({node,attributes,children})=>{
  const tag=['h1','h2','h3','blockquote'].includes(node.style??'')?node.style!:'div';
  return <div {...attributes}><BlockFrame id={node._key}>{React.createElement(tag,{style:{textAlign:['left','center','right'].includes(String((node as unknown as PortableBlock).alignment))?(node as unknown as PortableBlock).alignment as 'left'|'center'|'right':'left',paddingLeft:node.listItem?`${(node.level??1)*1.5}em`:undefined}},node.listItem?<span contentEditable={false} aria-hidden="true">{node.listItem==='bullet'?'• ':'1. '}</span>:null,children)}</BlockFrame></div>;
}}),defineBlockObject({type:'hailCta',render:({node,attributes,children})=><div {...attributes}><BlockFrame id={node._key}><CallToAction node={node as PortableBlock}/>{children}</BlockFrame></div>}),defineBlockObject({type:'hailImage',render:({node,attributes,children})=><div {...attributes}><BlockFrame id={node._key}><ImageContent node={node as PortableBlock}/>{children}</BlockFrame></div>}),
...(['strong','em','code'] as const).map(type=>defineDecorator({type,render:({children})=>React.createElement(type,null,children)})),
  defineAnnotation({type:'link',render:({children})=><span className="builder-link">{children}</span>})];
const iconPaths={
  undo:'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 6 6v3',
  redo:'m15 5 5 5-5 5m5-5H10a6 6 0 0 0-6 6v3',
  link:'m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  unlink:'m3 3 18 18M8 16l-1 1a4 4 0 0 1-6-6l2-2m10-2 1-1a4 4 0 0 1 6 6l-2 2',
  bullets:'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
  numbered:'M10 6h11M10 12h11M10 18h11M3 4h1v5M3 9h2M2 15a2 2 0 0 1 4 0c0 2-4 2-4 5h4',
  indent:'M3 4h18M11 9h10M11 14h10M3 20h18m-18-12 4 4-4 4',
  outdent:'M3 4h18M11 9h10M11 14h10M3 20h18M7 8l-4 4 4 4',
  left:'M3 5h18M3 10h12M3 15h18M3 20h12',
  center:'M3 5h18M6 10h12M3 15h18M6 20h12',
  right:'M3 5h18M9 10h12M3 15h18M9 20h12',
  more:'M5 12h.01M12 12h.01M19 12h.01',
};
function ToolbarIcon({name}:{name:keyof typeof iconPaths}){
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}
function Toolbar({images,issue}:{images:boolean;issue:(message:string,kind?:NoticeKind)=>void}){
  const assets=React.useContext(Assets);
  const [uploading,setUploading]=React.useState(false);
  const editor=useEditor(),editorFocus=useEditorSelector(editor,getFocusBlock),style=useEditorSelector(editor,getActiveStyle),list=useEditorSelector(editor,getActiveListItem);
  const strong=useEditorSelector(editor,isActiveDecorator('strong')),em=useEditorSelector(editor,isActiveDecorator('em')),code=useEditorSelector(editor,isActiveDecorator('code'));
  const objectSelection=React.useContext(ObjectSelection),value=useEditorSelector(editor,getValue);
  const selected=value.find(block=>block._key===objectSelection.key);
  const focus=editorFocus??(selected?{node:selected,path:[{_key:selected._key}] as [{_key:string}]}:undefined);
  const canFormat=focus?.node._type==='block';
  const canAlign=canFormat||focus?.node._type==='hailCta';
  const alignment=String((focus?.node as PortableBlock|undefined)?.alignment??'left');
  const menu=React.useRef<HTMLDetailsElement>(null);
  const send=(event:EditorEvent)=>{if(event.type==='insert.blocks'&&!editorFocus&&selected)editor.send({type:'select.block',at:[{_key:selected._key}]});if(['insert.blocks','delete.block','history.undo','history.redo'].includes(event.type))objectSelection.select(null);if(menu.current)menu.current.open=false;editor.send(event);editor.send({type:'focus'});};
  const button=(label:string,event:EditorEvent,content:React.ReactNode=label,pressed?:boolean,disabled=false)=><button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled||(!canFormat&&['decorator.toggle','annotation.remove','list item.toggle'].includes(event.type))} onMouseDown={e=>e.preventDefault()} onClick={()=>send(event)}>{content}</button>;
  function link(){const href=window.prompt('HTTPS link URL');if(!href)return;try{const url=new URL(href);if(!href.startsWith('https://')||url.username||url.password)throw Error();send({type:'annotation.add',annotation:{name:'link',value:{href}}});}catch{issue('Use an absolute HTTPS URL without credentials.');}}
  async function addImage(file:File){
    setUploading(true);
    try{
      if(file.size>196608)throw Error(`This image is ${Math.ceil(file.size/1024).toLocaleString()} KiB. The limit is 192 KiB per PNG. Compress it or choose a smaller file.`);
      if(getValue(editor.getSnapshot()).filter(block=>block._type==='hailImage').length>=8)throw Error('Use up to eight images per message.');
      const asset=await pngAsset(new Uint8Array(await file.arrayBuffer()),true);
      const bitmap=await createImageBitmap(file);bitmap.close();
      assets.set(asset.id,asset);
      send({type:'insert.blocks',blocks:[{_type:'hailImage',_key:crypto.randomUUID(),asset:asset.id,alt:''}],placement:'after',select:'start'});
    }catch(error){issue(error instanceof Error?error.message:'Could not add this image.');}finally{setUploading(false);}
  }
  const blocks=useEditorSelector(editor,getValue);
  const index=blocks.findIndex(block=>block._key===focus?.node._key);
  const pinned=isHeaderBlock(focus?.node,assets);
  const hasHeader=isHeaderBlock(blocks[0],assets);
  const level=Number(focus?.node.level??1);
  const styles={normal:'Paragraph',h1:'Heading 1',h2:'Heading 2',h3:'Heading 3',blockquote:'Quote',caption:'Caption'};
  return <div className="builder-toolbar" role="group" aria-label="Rich text formatting">
    <div className="builder-tool-group">
      {button('Undo',{type:'history.undo'},<ToolbarIcon name="undo"/>)}{button('Redo',{type:'history.redo'},<ToolbarIcon name="redo"/>)}
    </div>
    <div className="builder-tool-group">
      <select disabled={!canFormat} aria-label="Block style" title="Block style" value={style??'normal'} onChange={e=>send({type:'style.add',style:e.target.value})}>{Object.entries(styles).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
    </div>
    <div className="builder-tool-group">
      {button('Bold',{type:'decorator.toggle',decorator:'strong'},<strong>B</strong>,strong)}{button('Italic',{type:'decorator.toggle',decorator:'em'},<em>I</em>,em)}{button('Code',{type:'decorator.toggle',decorator:'code'},<span className="builder-code-icon">&lt;/&gt;</span>,code)}
    </div>
    <div className="builder-tool-group">
      <button type="button" disabled={!canFormat} aria-label="Link" title="Link" onMouseDown={e=>e.preventDefault()} onClick={link}><ToolbarIcon name="link"/></button>{button('Remove link',{type:'annotation.remove',annotation:{name:'link'}},<ToolbarIcon name="unlink"/>)}
    </div>
    <div className="builder-tool-group">
      {button('Bullets',{type:'list item.toggle',listItem:'bullet'},<ToolbarIcon name="bullets"/>,list==='bullet')}{button('Numbered',{type:'list item.toggle',listItem:'number'},<ToolbarIcon name="numbered"/>,list==='number')}
      {focus&&list&&<>{button('Outdent',{type:'block.set',at:focus.path,props:{level:level-1}},<ToolbarIcon name="outdent"/>,undefined,level<=1)}{button('Indent',{type:'block.set',at:focus.path,props:{level:level+1}},<ToolbarIcon name="indent"/>,undefined,level>=3)}</>}
    </div>
    <div className="builder-tool-group" role="group" aria-label="Text alignment">
      {(['left','center','right'] as const).map(value=><button key={value} type="button" aria-label={`Align ${value}`} title={`Align ${value}`} aria-pressed={canAlign&&alignment===value} disabled={!canAlign} onMouseDown={event=>event.preventDefault()} onClick={()=>{if(focus)send(value==='left'?{type:'block.unset',at:focus.path,props:['alignment']}:{type:'block.set',at:focus.path,props:{alignment:value}});}}><ToolbarIcon name={value}/></button>)}
    </div>
    <div className="builder-tool-group builder-insert">
      {button('Add paragraph',{type:'insert.blocks',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'',marks:[]}],markDefs:[]}],placement:'after',select:'start'},'＋ Text')}
      {button('Add call to action',{type:'insert.blocks',blocks:[{_type:'hailCta',_key:crypto.randomUUID(),label:'Learn more',href:''}],placement:'after',select:'start'},'＋ Button')}
      {images&&<label className="builder-add-image" title="Add a PNG up to 192 KiB (8 images per message)">{uploading?'Adding…':'＋ Image'}<input aria-label="Add image" type="file" accept="image/png" disabled={uploading} onChange={event=>{const file=event.target.files?.[0];if(file)void addImage(file);event.target.value='';}}/></label>}
    </div>
    <details className="builder-more" ref={menu} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}>
      <summary aria-label="Block actions" title="Block actions"><ToolbarIcon name="more"/></summary>
      <div className="builder-block-actions" role="group" aria-label="Block actions">
        {focus&&<>{button('Move up',{type:'move.block up',at:focus.path},'Move up',undefined,pinned||index<=0||index===1&&hasHeader)}{button('Move down',{type:'move.block down',at:focus.path},'Move down',undefined,pinned||index===blocks.length-1)}
          <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{const block=structuredClone(focus.node);block._key=crypto.randomUUID();if(block._type==='hailImage'&&'asset' in block){const asset=assets.get(String(block.asset));if(asset?.role==='header'){const id='image-'+crypto.randomUUID();assets.set(id,{...asset,id,role:'image'});block.asset=id;}}if('children' in block&&Array.isArray(block.children))block.children=block.children.map(s=>({...s,_key:crypto.randomUUID()}));send({type:'insert.blocks',blocks:[block],placement:'after',select:'start'});}}>Duplicate block</button>
          {button('Delete block',{type:'delete.block',at:focus.path})}</>}
      </div>
    </details>
  </div>;
}
function Changes({change,issue}:{change:(blocks:PortableBlock[])=>void;issue:(message:string,kind?:NoticeKind)=>void}){
  const editor=useEditor();
  return <EventListenerPlugin on={event=>{
    if(event.type==='operation'||event.type==='mutation')queueMicrotask(()=>change(structuredClone(getValue(editor.getSnapshot())) as PortableBlock[]));
    if(event.type==='invalid value')issue('The editor rejected this document.');
  }}/>;
}
export function mountEditor(element:HTMLElement,initial:PortableBlock[],change:(blocks:PortableBlock[],assets:HeaderAsset[])=>void,issue:(message:string,kind?:NoticeKind)=>void,initialAssets:HeaderAsset[]=[],images=true,inspectorTarget:HTMLElement){
  const assets=new Map(initialAssets.map(asset=>[asset.id,asset]));
  const root=createRoot(element);
  root.render(<EditorProvider initialConfig={{schemaDefinition,initialValue:initial.map(editorBlock) as PortableTextBlock[]}}>
    <ObjectSelectionProvider><Notify.Provider value={issue}><Assets.Provider value={assets}><Dragged.Provider value={{key:null}}><NodePlugin nodes={nodes}/><Toolbar images={images} issue={issue}/>
    <Changes change={blocks=>{
      const used=[...new Set(blocks.filter(block=>block._type==='hailImage').map(block=>String(block.asset)))];
      change(blocks.map(portableBlock),[...assets.keys()].filter(id=>used.includes(id)).flatMap(id=>{const asset=assets.get(id);return asset?[asset]:[];}));
    }} issue={issue}/>
    <div className="builder-workspace"><div className="builder-canvas"><PortableTextEditable aria-label="Message content" spellCheck
      onPaste={({event})=>{const text=event.clipboardData.getData('text/plain');if(event.clipboardData.types.includes('text/html'))issue('Pasted plain text; HTML formatting is not imported.','info');return {insert:[{_type:'block',_key:crypto.randomUUID(),style:'normal',markDefs:[],children:[{_type:'span',_key:crypto.randomUUID(),text,marks:[]}]}]};}}
    /></div></div><SettingsPanel target={inspectorTarget} element={element}/>
  </Dragged.Provider></Assets.Provider></Notify.Provider></ObjectSelectionProvider></EditorProvider>);
  return ()=>root.unmount();
}
