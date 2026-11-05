import React from 'react';
import {createRoot} from 'react-dom/client';
import {EditorProvider, PortableTextEditable, defineSchema, defineTextBlock, defineDecorator, defineAnnotation, useEditor, useEditorSelector, type PortableTextBlock, type EditorEvent} from '@portabletext/editor';
import {EventListenerPlugin, NodePlugin} from '@portabletext/editor/plugins';
import {getValue, getFocusBlock, getActiveStyle, isActiveDecorator, getActiveListItem} from '@portabletext/editor/selectors';
import type {PortableBlock} from './core.js';

export const schemaDefinition=defineSchema({
  styles:['normal','h1','h2','h3','blockquote','caption'].map(name=>({name})),
  decorators:['strong','em','code'].map(name=>({name})),lists:[{name:'bullet'},{name:'number'}],
  annotations:[{name:'link',fields:[{name:'href',type:'string'},{name:'title',type:'string'}]}],
  inlineObjects:[],blockObjects:[],
});
const nodes=[defineTextBlock({type:'block',render:({node,attributes,children})=>{
  const tag=['h1','h2','h3','blockquote'].includes(node.style??'')?node.style!:'div';
  return React.createElement(tag,{...attributes,style:{paddingLeft:node.listItem?`${(node.level??1)*1.5}em`:undefined}},node.listItem?<span contentEditable={false} aria-hidden="true">{node.listItem==='bullet'?'• ':'1. '}</span>:null,children);
}}),...(['strong','em','code'] as const).map(type=>defineDecorator({type,render:({children})=>React.createElement(type,null,children)})),
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
  more:'M5 12h.01M12 12h.01M19 12h.01',
};
function ToolbarIcon({name}:{name:keyof typeof iconPaths}){
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}
function Toolbar(){
  const editor=useEditor(),focus=useEditorSelector(editor,getFocusBlock),style=useEditorSelector(editor,getActiveStyle),list=useEditorSelector(editor,getActiveListItem);
  const strong=useEditorSelector(editor,isActiveDecorator('strong')),em=useEditorSelector(editor,isActiveDecorator('em')),code=useEditorSelector(editor,isActiveDecorator('code'));
  const menu=React.useRef<HTMLDetailsElement>(null);
  const send=(event:EditorEvent)=>{if(menu.current)menu.current.open=false;editor.send(event);editor.send({type:'focus'});};
  const button=(label:string,event:EditorEvent,content:React.ReactNode=label,pressed?:boolean,disabled=false)=><button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onMouseDown={e=>e.preventDefault()} onClick={()=>send(event)}>{content}</button>;
  function link(){const href=window.prompt('HTTPS link URL');if(!href)return;try{const url=new URL(href);if(!href.startsWith('https://')||url.username||url.password)throw Error();send({type:'annotation.add',annotation:{name:'link',value:{href}}});}catch{window.alert('Use an absolute HTTPS URL without credentials.');}}
  const level=Number(focus?.node.level??1);
  const styles={normal:'Paragraph',h1:'Heading 1',h2:'Heading 2',h3:'Heading 3',blockquote:'Quote',caption:'Caption'};
  return <div className="builder-toolbar" role="group" aria-label="Rich text formatting">
    <div className="builder-tool-group">
      {button('Undo',{type:'history.undo'},<ToolbarIcon name="undo"/>)}{button('Redo',{type:'history.redo'},<ToolbarIcon name="redo"/>)}
    </div>
    <div className="builder-tool-group">
      <select aria-label="Block style" title="Block style" value={style??'normal'} onChange={e=>send({type:'style.add',style:e.target.value})}>{Object.entries(styles).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
    </div>
    <div className="builder-tool-group">
      {button('Bold',{type:'decorator.toggle',decorator:'strong'},<strong>B</strong>,strong)}{button('Italic',{type:'decorator.toggle',decorator:'em'},<em>I</em>,em)}{button('Code',{type:'decorator.toggle',decorator:'code'},<span className="builder-code-icon">&lt;/&gt;</span>,code)}
    </div>
    <div className="builder-tool-group">
      <button type="button" aria-label="Link" title="Link" onMouseDown={e=>e.preventDefault()} onClick={link}><ToolbarIcon name="link"/></button>{button('Remove link',{type:'annotation.remove',annotation:{name:'link'}},<ToolbarIcon name="unlink"/>)}
    </div>
    <div className="builder-tool-group">
      {button('Bullets',{type:'list item.toggle',listItem:'bullet'},<ToolbarIcon name="bullets"/>,list==='bullet')}{button('Numbered',{type:'list item.toggle',listItem:'number'},<ToolbarIcon name="numbered"/>,list==='number')}
      {focus&&list&&<>{button('Outdent',{type:'block.set',at:focus.path,props:{level:level-1}},<ToolbarIcon name="outdent"/>,undefined,level<=1)}{button('Indent',{type:'block.set',at:focus.path,props:{level:level+1}},<ToolbarIcon name="indent"/>,undefined,level>=3)}</>}
    </div>
    <details className="builder-more" ref={menu} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))e.currentTarget.open=false;}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus();}}}>
      <summary aria-label="Block actions" title="Block actions"><ToolbarIcon name="more"/></summary>
      <div className="builder-block-actions" role="group" aria-label="Block actions">
        {button('Add paragraph',{type:'insert.blocks',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'',marks:[]}],markDefs:[]}],placement:'after',select:'start'})}
        {focus&&<>{button('Move up',{type:'move.block up',at:focus.path})}{button('Move down',{type:'move.block down',at:focus.path})}
          <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{const block=structuredClone(focus.node);block._key=crypto.randomUUID();if('children' in block&&Array.isArray(block.children))block.children=block.children.map(s=>({...s,_key:crypto.randomUUID()}));send({type:'insert.blocks',blocks:[block],placement:'after',select:'start'});}}>Duplicate block</button>
          {button('Delete block',{type:'delete.block',at:focus.path})}</>}
      </div>
    </details>
  </div>;
}
function Changes({change,issue}:{change:(blocks:PortableBlock[])=>void;issue:(message:string)=>void}){
  const editor=useEditor();
  return <EventListenerPlugin on={event=>{
    if(event.type==='operation'||event.type==='mutation')queueMicrotask(()=>change(structuredClone(getValue(editor.getSnapshot())) as PortableBlock[]));
    if(event.type==='invalid value')issue('The editor rejected this document.');
  }}/>;
}
export function mountEditor(element:HTMLElement,initial:PortableBlock[],change:(blocks:PortableBlock[])=>void,issue:(message:string)=>void){
  const root=createRoot(element);
  root.render(<EditorProvider initialConfig={{schemaDefinition,initialValue:initial as PortableTextBlock[]}}>
    <NodePlugin nodes={nodes}/><Toolbar/>
    <Changes change={change} issue={issue}/>
    <PortableTextEditable aria-label="Message content" spellCheck
      onPaste={({event})=>{const text=event.clipboardData.getData('text/plain');if(event.clipboardData.types.includes('text/html'))issue('Pasted plain text; HTML formatting is not imported.');return {insert:[{_type:'block',_key:crypto.randomUUID(),style:'normal',markDefs:[],children:[{_type:'span',_key:crypto.randomUUID(),text,marks:[]}]}]};}}
    />
  </EditorProvider>);
  return ()=>root.unmount();
}
