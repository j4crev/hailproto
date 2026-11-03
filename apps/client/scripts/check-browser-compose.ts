import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=true;
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_SENT_AUDIENCES:"1",HAIL_DESIGN_EXTRA_REPLIES:sharedMode?"0":"35",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out');};
try{
let port='';await wait(async()=>{try{port=(await readFile(work+'/DevToolsActivePort','utf8')).split('\n')[0];return port;}catch{return false;}});
const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();socket=new WebSocket(targets.find((t:any)=>t.type==='page').webSocketDebuggerUrl);
await new Promise<void>(resolve=>socket!.onopen=()=>resolve());
let id=0;const pending=new Map<number,any>();socket.onmessage=event=>{const v=JSON.parse(String(event.data));if(pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result);}};
const cdp=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket!.send(JSON.stringify({id:n,method,params}));});
const evaluate=async(expression:string)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
await cdp('Page.enable');await cdp('Runtime.enable');
const origin=`http://localhost:${fixturePort}`;
// The fixture API starts before the GUI; wait for rendered HTML before navigating.
await wait(async()=>{try{return (await fetch(origin+'/?view=connections')).ok;}catch{return false;}});

async function navigate(path:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`!!document.querySelector('form.compose-layout') && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

for(const width of [1440,900,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await cdp('Page.navigate',{url:origin+'/sent'});
  await wait(async()=>evaluate(`document.querySelectorAll('.sent-avatar').length===4 && document.readyState==='complete'`));
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.message-sender'),e=>e.textContent)`),['alex@connections.example.com','Multiple recipients','essays','General']);
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    assert(await evaluate(`Array.from(document.querySelectorAll('.sent-avatar')).every(e=>e.textContent==='J' && getComputedStyle(e).backgroundColor===${JSON.stringify(theme==='light'?'rgb(18, 115, 101)':'rgb(94, 214, 195)')})`),'Sender initials and theme colors');
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Sent fits '+width);
  }
  await navigate('/compose');
  const toggleSelector=width<=900?'.mobile-floating-action':'.preview-toggle';
  const toggle=async()=>evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).click()`);
  assert(await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).checkVisibility()`),'Active preview toggle is visible');
  assert(await evaluate(`!document.querySelector(${JSON.stringify(width<=900?'.preview-toggle':'.mobile-floating-action')}).checkVisibility()`),'Only one preview toggle is visible');
  if(width<=900){
    assert(await evaluate(`(()=>{const r=document.querySelector('.mobile-floating-action').getBoundingClientRect();return r.width===56&&r.height===56&&Math.abs(r.x+r.width/2-document.documentElement.clientWidth/2)<1&&Math.abs(innerHeight-r.bottom-40)<1;})()`),'Mobile action matches compose placement');
  }
  const input=async(selector:string,value:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert(await evaluate(`!document.querySelector('.compose-settings')`),'No Publication sidebar');
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).get('category')`),'');
  assert.equal(await evaluate(`document.querySelector('#category-search').value`),'');
  assert(await evaluate(`document.querySelector('.send-bar .hail-button').disabled`));
  assert(await evaluate(`document.querySelector('.category-line').compareDocumentPosition(document.querySelector('.sender-line')) & Node.DOCUMENT_POSITION_FOLLOWING`));
  await evaluate(`document.querySelector('#category-search').focus()`);
  await input('#category-search','ess');
  await wait(async()=>evaluate(`document.querySelectorAll('.category-option').length===1`));
  await evaluate(`document.querySelector('#category-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).get('category')`),'essays');
  assert.equal(await evaluate(`document.querySelector('#category-search').getAttribute('aria-expanded')`),'false');
  await input('#category-search','not a category');
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).get('category')`),'');
  assert(await evaluate(`document.querySelector('.send-bar .hail-button').disabled`));
  assert(await evaluate(`document.querySelector('#category-suggestions').parentElement.textContent.includes('No matching categories.')`));
  await evaluate(`document.querySelector('#category-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await evaluate(`document.querySelector('#category-search').value`),'essays');
  await evaluate(`document.querySelector('#category-search').focus()`);
  await input('#category-search','gen');
  const categoryPoint=await evaluate(`(()=>{const r=document.querySelector('.category-option').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...categoryPoint});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...categoryPoint});
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).get('category')`),'general');
  await evaluate(`document.querySelector('input[name=allowReply]').click()`);
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).get('allowReply')`),'yes');
  await input('input[name=title]','A fresh perspective');
  await input('textarea','Hello **everyone**.');
  await toggle();
  await wait(async()=>evaluate(`!document.querySelector('#compose-preview').hidden`));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).getAttribute('aria-expanded')`),'true');
  assert(await evaluate(`document.querySelector('#compose-preview h1')?.textContent==='A fresh perspective'`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Subscriber preview fits '+width);
  await toggle();
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'Hello **everyone**.');
  assert(await evaluate(`!document.querySelector('input[name=mode]')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Subscriber editor fits '+width);
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ6kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'cover.png',{type:'image/png'}));const e=document.querySelector('input[name=header]');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(async()=>evaluate(`!!document.querySelector('.cover-thumbnail')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Cover controls fit '+width);
  await toggle();
  await evaluate(`document.querySelector('.send-bar .hail-button').click()`);
  await wait(async()=>evaluate(`document.querySelector('#compose-preview').hidden && document.activeElement.name==='alt'`));
  assert(await evaluate(`!document.querySelector('[role=alert]')`),'Missing image description blocks sending and returns to editing');
  await input('input[name=alt]','A cover description');
  await input('input[name=caption]','A cover caption');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Remove image').click()`);
  await wait(async()=>evaluate(`!document.querySelector('.cover-thumbnail')`));
  assert(await evaluate(`document.querySelector('input[name=header]').files.length===0`),'Removal clears the actual upload');
  assert(await evaluate(`(()=>{const form=new FormData(document.querySelector('form[enctype]'));return form.get('header').size===0&&form.get('alt')===''&&form.get('caption')==='';})()`),'Removed image and metadata are absent from submission');
  assert(await evaluate(`!document.querySelector('input[name=alt]').required && document.querySelector('form[enctype]').checkValidity()`));
  assert(await evaluate(`document.activeElement===document.querySelector('.cover-control summary')`),'Removal returns focus to the cover control');
  await toggle();
  assert(await evaluate(`!document.querySelector('#compose-preview img')`),'Preview has no removed image');
  await navigate('/compose?audience=connections');
  const key=async(key:string)=>evaluate(`document.querySelector('#recipient-search').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}))`);
  await evaluate(`document.querySelector('#recipient-search').focus()`);
  await input('#recipient-search','alex');
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-option').length===1`));
  await key('Enter');
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===1`));
  assert.equal(await evaluate(`document.querySelector('#recipient-search').value`),'');
  assert.equal(await evaluate(`document.activeElement.id`),'recipient-search');
  assert.equal(await evaluate(`document.querySelectorAll('.recipient-option').length`),1,'Selected recipients are excluded');
  await key('Escape');
  assert.equal(await evaluate(`document.querySelector('#recipient-search').getAttribute('aria-expanded')`),'false');
  await key('ArrowDown');
  assert.equal(await evaluate(`document.querySelector('#recipient-search').getAttribute('aria-activedescendant')`),'recipient-option-0');
  // Use an actual pointer click to prove the input blur does not swallow selection.
  const point=await evaluate(`(()=>{const r=document.querySelector('.recipient-option').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===2`));
  await input('#recipient-search','no match');
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).getAll('connection').length`),2,'Typing keeps selected recipients');
  assert.equal(await evaluate(`document.querySelectorAll('.recipient-option').length`),0);
  assert(await evaluate(`!document.querySelector('input[name=delivery]')`));
  await input('textarea','A personal hello');
  assert(await evaluate(`document.querySelector('.send-bar .hail-button').disabled`),'Unresolved address cannot be silently omitted');
  await key('Enter');
  assert(await evaluate(`!document.querySelector('[role=alert]')`),'Enter with no match does not submit');
  await evaluate(`document.querySelector('.recipient-chip').click()`);
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===1`));
  assert.equal(await evaluate(`new FormData(document.querySelector('form[enctype]')).getAll('connection').length`),1);
  assert(await evaluate(`!document.querySelector('input[name=delivery]')`));
  await input('#recipient-search','');
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-option').length===1`));
  await key('Enter');
  await wait(async()=>evaluate(`document.querySelectorAll('.recipient-chip').length===2`));
  assert.equal(await evaluate(`document.querySelector('#recipient-search').placeholder`),'');
  assert.equal(await evaluate(`document.querySelector('#recipient-search').getAttribute('aria-expanded')`),'false');
  assert(await evaluate(`document.querySelector('.recipient-suggestions').hidden`));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#recipient-search')).outlineStyle`),'none');
  assert(await evaluate(`!document.querySelector('.compose-settings')`),'Connections has no recipient sidebar');
  await toggle();
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Connection preview fits '+width);
  await toggle();
  // The fixture intentionally rejects sends; the draft and recipients must survive.
  await evaluate(`document.querySelector('.send-bar .hail-button').click()`);
  await wait(async()=>evaluate(`document.querySelector('[role=alert]')?.textContent.includes('not confirmed')`));
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'A personal hello');
  assert.equal(await evaluate(`document.querySelectorAll('.recipient-chip').length`),2);
  assert(await evaluate(`!document.querySelector('input[name=delivery]')`));
  assert(await evaluate(`!document.querySelector('.send-bar .hail-button').disabled`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Connection editor fits '+width);
  console.log('PASS: compose editing, preview, search, delivery, retry and layout at '+width);
}

for(const width of [1440,390]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/compose');
  const input=async(selector:string,value:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await input('input[name=title]','Saved draft '+width);await input('textarea','Unfinished message');
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ6kAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'cover.png',{type:'image/png'}));const e=document.querySelector('input[name=header]');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const draftId=await evaluate(`document.querySelector('input[name=publicationId]').value`);
  await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='1'`));
  assert(await evaluate(`document.body.textContent.includes('Draft saved.')`),'Incomplete message and missing alt text can be saved');
  await navigate('/compose?draft='+draftId);
  assert.equal(await evaluate(`document.querySelector('input[name=title]').value`),'Saved draft '+width);
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'Unfinished message');
  assert(await evaluate(`document.querySelector('.cover-thumbnail').src.startsWith('data:image/png;base64,')`),'Cover survives a fresh page load');
  await input('textarea','Edited draft');await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='2'`));
  await cdp('Page.navigate',{url:origin+'/drafts'});
  await wait(async()=>evaluate(`!!document.querySelector('a[href="/compose?draft=${draftId}"]') && document.readyState==='complete'`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Draft list fits '+width);
  await evaluate(`document.querySelector('a[href="/compose?draft=${draftId}"]').closest('article').querySelector('.selection-avatar').click()`);
  await wait(async()=>evaluate(`!!document.querySelector('button[aria-label="Delete selected drafts"]')`));
  await evaluate(`document.querySelector('button[aria-label="Delete selected drafts"]').click()`);
  await wait(async()=>evaluate(`!document.querySelector('a[href="/compose?draft=${draftId}"]')`));
  await cdp('Page.navigate',{url:origin+'/trash'});
  await wait(async()=>evaluate(`!!document.querySelector('section[aria-label="Trashed drafts"] button') && document.readyState==='complete'`));
  await evaluate(`document.querySelector('section[aria-label="Trashed drafts"] .selection-avatar').click()`);
  await wait(async()=>evaluate(`!!document.querySelector('button[aria-label="Restore selected drafts"]')`));
  await evaluate(`document.querySelector('button[aria-label="Restore selected drafts"]').click()`);
  await wait(async()=>evaluate(`!document.querySelector('section[aria-label="Trashed drafts"]')`));
  await navigate('/compose?draft='+draftId);
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'Edited draft');
  // Another signed-in client saves a newer revision. The stale editor retains its text.
  await evaluate(`(async()=>{const draft=await(await fetch('/api/v1/account/drafts/${draftId}')).json();await fetch('/api/v1/account/drafts/${draftId}/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:draft.revision,content:{...draft.content,text:'Other device'}})});})()`);
  await input('textarea','My unsaved changes');await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('[role=alert]')?.textContent.includes('another device')`));
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'My unsaved changes');
  console.log('PASS: draft save, reload, image persistence, update, avatar deletion, restore and stale-edit protection at '+width);
}
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
