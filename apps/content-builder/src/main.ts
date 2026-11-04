import {mountBuilder} from '@racrproto/content-builder';
import {emptyBody,parseBuilderDraft} from '@racrproto/content-builder/core';
import './style.css';
const key='standalone-content:v1';
let saved:{revision:number;draft:ReturnType<typeof parseBuilderDraft>}|null=null;
const status=document.querySelector<HTMLElement>('#handoff')!;
try{const raw=localStorage.getItem(key);if(raw){const v=JSON.parse(raw);if(!Number.isSafeInteger(v.revision)||v.revision<1)throw Error('Invalid revision');saved={revision:v.revision,draft:parseBuilderDraft(v.draft)};}}
catch{status.textContent='Saved content could not be read. Local recovery and export remain available.';}
const instance=mountBuilder(document.querySelector<HTMLElement>('#builder')!,{
  version:1,profiles:['spt-2','spt-3'],initial:saved?.draft??{version:1,body:emptyBody()},revision:saved?.revision??0,
  async save(draft,expected){
    if(!navigator.locks)throw Error('Saving needs a browser with Web Locks. Export your bundle instead.');
    return navigator.locks.request(key,()=>{
      const current=JSON.parse(localStorage.getItem(key)??'null');
      if((current?.revision??0)!==expected)throw Error('Another tab saved a newer version. Export your work before reloading.');
      const revision=expected+1;localStorage.setItem(key,JSON.stringify({revision,draft:parseBuilderDraft(draft)}));return {revision};
    });
  },
  handoff(draft){
    const url=URL.createObjectURL(new Blob([JSON.stringify(draft.body,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.download='hail-body.json';a.href=url;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent='Validated content exported. A publishing host can accept this body; this app does not send messages.';
  },
},{recoveryKey:'standalone'});
window.addEventListener('pagehide',()=>void instance.dispose(),{once:true});
