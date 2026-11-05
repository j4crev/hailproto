import {mount,unmount} from 'svelte';
import Builder from './Builder.svelte';
import {parseBuilderDraft,type BuilderDraft,type BuilderHost} from './core.js';
export type {BuilderHost,BuilderDraft,BuilderBody,Diagnostic} from './core.js';
/** Framework-neutral DOM integration; no globals, credentials, routing or publication API. */
export function mountBuilder(target:HTMLElement,host:BuilderHost) {
  if(host.version!==1)throw new Error('Unsupported builder host contract');
  const component=mount(Builder,{target,props:{initial:parseBuilderDraft(host.initial),profiles:host.profiles,revision:host.revision,
    onchange:host.change,onsave:(draft:BuilderDraft,revision:number)=>host.save(draft,revision),onhandoff:(draft:BuilderDraft)=>host.handoff(draft)}});
  return {dispose:()=>unmount(component)};
}
