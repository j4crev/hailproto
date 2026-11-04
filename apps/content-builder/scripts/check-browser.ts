import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
import {resolve} from 'node:path';
import {validateBody,toPortable,fromPortable,semantics,pngAsset} from '@racrproto/content-builder/core';
import fixture from '../../../packages/hail-content-builder/fixtures/text.json';
const root=resolve(import.meta.dir,'../dist');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const path=new URL(req.url).pathname;const file=resolve(root,'.'+(path==='/'?'/index.html':path));return file.startsWith(root+'/')&&await Bun.file(file).exists()?new Response(Bun.file(file)):new Response(null,{status:404});}});
const origin=`http://127.0.0.1:${server.port}`;
const work=await mkdtemp('/tmp/hail-builder-browser-');
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<unknown>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw Error('Timed out: '+String(fn));};
try{
let port='';await wait(async()=>{try{port=(await readFile(work+'/DevToolsActivePort','utf8')).split('\n')[0];return port;}catch{return false;}});
const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(tabs.find((v:any)=>v.type==='page').webSocketDebuggerUrl);
await new Promise<void>(resolve=>socket!.onopen=()=>resolve());
let id=0;const pending=new Map<number,any>(),requests:string[]=[],exceptions:unknown[]=[];
socket.onmessage=event=>{const v=JSON.parse(String(event.data));if(pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result);}else if(v.method==='Network.requestWillBeSent')requests.push(v.params.request.url);else if(v.method==='Runtime.exceptionThrown')exceptions.push(v.params.exceptionDetails);};
const cdp=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression:string)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');
const navigate=async()=>{await cdp('Page.navigate',{url:origin});await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));};
const click=async(label:string)=>{assert(await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`),'enabled '+label);};
const upload=async(bundle:unknown)=>{await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(bundle))}],'bundle.json',{type:'application/json'}));const input=document.querySelector('input[accept="application/json,.json"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);await wait(()=>evaluate(`document.body.textContent.includes('Bundle imported.')`));};
const saved=()=>evaluate(`JSON.parse(localStorage.getItem('standalone-content:v1'))`);
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
const body=validateBody({version:1,profile:'spt-3',assets:{version:1,assets:[await pngAsset(png)]},blocks:[{_type:'spt.image',asset:'header',alt:'One pixel',caption:'Bundled caption'},...fixture.blocks]});
await navigate();await upload(toPortable(body));
await wait(()=>evaluate(`document.querySelector('.preview img')?.complete`));
await click('Save draft');await wait(async()=>!!await saved());
assert.deepEqual(semantics((await saved()).draft.body),semantics(body),'real editor load/save preserves all supported semantics');
assert(await evaluate(`document.querySelector('.preview').textContent.includes('Visit <example>')`),'sender text escaped');
assert.equal(await evaluate(`document.querySelector('.preview img').getAttribute('src').startsWith('data:image/png')`),true);
// Real keyboard input, undo/redo, and local recovery after reload.
await evaluate(`(()=>{const editor=document.querySelector('[contenteditable=true]');editor.focus();const r=document.createRange();r.selectNodeContents(editor);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
await cdp('Input.insertText',{text:'Recover this text'});
await wait(()=>evaluate(`document.querySelector('.preview').textContent.includes('Recover this text')`));
await click('Undo');await wait(()=>evaluate(`!document.querySelector('.preview').textContent.includes('Recover this text')`));
await click('Redo');await wait(()=>evaluate(`document.querySelector('.preview').textContent.includes('Recover this text')`));
await wait(()=>evaluate(`JSON.parse(localStorage.getItem('hail-builder:v1:standalone')??'null')?.bundle.blocks.some(b=>b.children?.some(s=>s.text.includes('Recover this text')))`));
await navigate();await wait(()=>evaluate(`document.body.textContent.includes('Restore local draft')`));await click('Restore local draft');
await wait(()=>evaluate(`document.querySelector('.preview').textContent.includes('Recover this text')`));
await click('Save draft');await wait(async()=>(await saved()).revision===2);
assert((await saved()).draft.body.blocks.some((b:any)=>b.children?.some((s:any)=>s.text.includes('Recover this text'))));
const beforeReorder=(await saved()).draft.body;
// Reordering is a native editor transaction and undo restores the block order.
await evaluate(`(()=>{const editor=document.querySelector('[contenteditable=true]');editor.focus();const r=document.createRange();r.selectNodeContents(editor);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
await wait(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Move up')`));
await click('Move up');await click('Save draft');await wait(async()=>(await saved()).revision===3);
assert.notDeepEqual(semantics((await saved()).draft.body),semantics(beforeReorder));
await click('Undo');await click('Save draft');await wait(async()=>(await saved()).revision===4);
assert.deepEqual(semantics((await saved()).draft.body),semantics(beforeReorder),'undo restores original order');
// Host revision conflict must preserve edits and the newer stored record.
await evaluate(`(()=>{const v=JSON.parse(localStorage.getItem('standalone-content:v1'));v.revision=5;localStorage.setItem('standalone-content:v1',JSON.stringify(v));})()`);
await click('Save draft');await wait(()=>evaluate(`document.body.textContent.includes('Another tab saved a newer version')`));
assert.equal((await saved()).revision,5);
// Narrow/light/dark/no-image previews, real focusable controls, and reflow.
for(const width of [1200,390,320]){
 await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'fits viewport '+width);
}
for(const label of ['Narrow','Dark','Images unavailable'])await evaluate(`Array.from(document.querySelectorAll('label')).find(e=>e.textContent.trim()===${JSON.stringify(label)}).querySelector('input').click()`);
assert.equal(await evaluate(`document.querySelectorAll('.preview img').length`),0);
assert(await evaluate(`document.querySelector('.preview [role=img]').getAttribute('aria-label')==='One pixel'`));
assert(await evaluate(`Array.from(document.querySelectorAll('button')).every(b=>b.type==='button')`),'embeddable controls cannot submit host forms');
assert.deepEqual(requests.filter(url=>!url.startsWith(origin)&&!url.startsWith('data:')&&!url.startsWith('blob:')),[],'no sender-controlled network requests');
assert.deepEqual(exceptions,[],'no browser exceptions');
console.log('PASS: actual Portable Text editing, semantic asset round trip, undo/redo, reorder, save/reload/recovery, stale save, responsive previews and zero remote requests');
}finally{socket?.close();chrome.kill();await chrome.exited;server.stop(true);await rm(work,{recursive:true,force:true});}
