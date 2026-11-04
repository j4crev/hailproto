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
function Toolbar(){
  const editor=useEditor(),focus=useEditorSelector(editor,getFocusBlock),style=useEditorSelector(editor,getActiveStyle),list=useEditorSelector(editor,getActiveListItem);
  const strong=useEditorSelector(editor,isActiveDecorator('strong')),em=useEditorSelector(editor,isActiveDecorator('em')),code=useEditorSelector(editor,isActiveDecorator('code'));
  const send=(event:EditorEvent)=>{editor.send(event);editor.send({type:'focus'});};
  const button=(label:string,event:EditorEvent,pressed?:boolean)=><button type="button" aria-pressed={pressed} onMouseDown={e=>e.preventDefault()} onClick={()=>send(event)}>{label}</button>;
  function link(){const href=window.prompt('HTTPS link URL');if(!href)return;try{const url=new URL(href);if(!href.startsWith('https://')||url.username||url.password)throw Error();send({type:'annotation.add',annotation:{name:'link',value:{href}}});}catch{window.alert('Use an absolute HTTPS URL without credentials.');}}
  return <div className="builder-toolbar" role="group" aria-label="Rich text formatting">
    {button('Undo',{type:'history.undo'})}{button('Redo',{type:'history.redo'})}
    <label>Style <select aria-label="Block style" value={style??'normal'} onChange={e=>send({type:'style.add',style:e.target.value})}>{schemaDefinition.styles.map(s=><option key={s.name} value={s.name}>{s.name}</option>)}</select></label>
    {button('Bold',{type:'decorator.toggle',decorator:'strong'},strong)}{button('Italic',{type:'decorator.toggle',decorator:'em'},em)}{button('Code',{type:'decorator.toggle',decorator:'code'},code)}
    <button type="button" onMouseDown={e=>e.preventDefault()} onClick={link}>Link</button>{button('Remove link',{type:'annotation.remove',annotation:{name:'link'}})}
    {button('Bullets',{type:'list item.toggle',listItem:'bullet'},list==='bullet')}{button('Numbered',{type:'list item.toggle',listItem:'number'},list==='number')}
    <label>List level <select aria-label="List level" disabled={!focus||!list} value={focus?.node.level as number??1} onChange={e=>{if(focus)send({type:'block.set',at:focus.path,props:{level:Number(e.target.value)}});}}>{[1,2,3].map(n=><option key={n}>{n}</option>)}</select></label>
    {button('Add paragraph',{type:'insert.blocks',blocks:[{_type:'block',style:'normal',children:[{_type:'span',text:'',marks:[]}],markDefs:[]}],placement:'after',select:'start'})}
    {focus&&<>{button('Move up',{type:'move.block up',at:focus.path})}{button('Move down',{type:'move.block down',at:focus.path})}
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{const block=structuredClone(focus.node);block._key=crypto.randomUUID();if('children' in block&&Array.isArray(block.children))block.children=block.children.map(s=>({...s,_key:crypto.randomUUID()}));send({type:'insert.blocks',blocks:[block],placement:'after',select:'start'});}}>Duplicate block</button>
      {button('Delete block',{type:'delete.block',at:focus.path})}</>}
  </div>;
}
function Changes({change,issue}:{change:(blocks:PortableBlock[])=>void;issue:(message:string)=>void}){
  const editor=useEditor();
  return <EventListenerPlugin on={event=>{
    if(event.type==='operation'||event.type==='mutation')queueMicrotask(()=>change(structuredClone(getValue(editor.getSnapshot())) as PortableBlock[]));
    if(event.type==='invalid value')issue('The editor rejected this document. Export it for recovery before replacing it.');
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
