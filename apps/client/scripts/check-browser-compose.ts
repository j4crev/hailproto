import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=true;
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_SENT_AUDIENCES:"1",HAIL_DESIGN_EXTRA_REPLIES:sharedMode?"0":"35",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out: '+String(fn));};
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

async function writeMessage(text:string){
  if(await evaluate(`!!document.querySelector('#message-text')`)){
    await evaluate(`(()=>{const e=document.querySelector('#message-text');e.focus();e.select();})()`);await cdp('Input.insertText',{text});return;
  }
  await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
  await evaluate(`(()=>{const e=document.querySelector('[contenteditable=true]');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  await cdp('Input.insertText',{text});
}
const messageText=()=>evaluate(`document.querySelector('#message-text')?.value??Array.from(document.querySelectorAll('[contenteditable=true] [data-block-key]')).filter(node=>!node.querySelector('.builder-image')).map(node=>node.textContent).join('')`);

for(const width of [1440,900,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await cdp('Page.navigate',{url:origin+'/sent'});
  await wait(async()=>evaluate(`document.querySelectorAll('.sent-list .selection-avatar:not(:disabled)').length===4 && document.readyState==='complete'`));
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.message-sender'),e=>e.textContent)`),['alex@connections.example.com','Multiple recipients','essays','General']);
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    assert(await evaluate(`Array.from(document.querySelectorAll('.sent-list .selection-avatar')).every(e=>e.textContent==='J' && e.getAttribute('aria-pressed')==='false' && getComputedStyle(e).backgroundColor===${JSON.stringify(theme==='light'?'rgb(228, 242, 236)':'rgb(41, 45, 44)')})`),'Sender initials and theme colors');
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Sent fits '+width);
  }
  await evaluate(`document.querySelector('.sent-list .selection-avatar').click()`);
  await wait(async()=>evaluate(`document.querySelector('.sent-list .selection-avatar').getAttribute('aria-pressed')==='true'`));
  assert(await evaluate(`Boolean(document.querySelector('button[aria-label="Delete selected messages"]'))`),'Sent selection exposes deletion');
  await evaluate(`document.querySelector('button[aria-label="Clear selection"]').click()`);
  await wait(async()=>evaluate(`!document.querySelector('.selection-actions')`));
  await navigate('/compose');
  const toggleSelector=width<=900?'.mobile-floating-action':'.preview-toggle';
  const toggle=async()=>evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).click()`);
  assert(await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).checkVisibility()`),'Active preview toggle is visible');
  assert(await evaluate(`!document.querySelector(${JSON.stringify(width<=900?'.preview-toggle':'.mobile-floating-action')}).checkVisibility()`),'Only one preview toggle is visible');
  if(width<=900){
    assert(await evaluate(`(()=>{const r=document.querySelector('.mobile-floating-action').getBoundingClientRect();return r.width===56&&r.height===56&&Math.abs(r.x+r.width/2-document.documentElement.clientWidth/2)<1&&Math.abs(innerHeight-r.bottom-40)<1;})()`),'Mobile action matches compose placement');
  }
  const input=async(selector:string,value:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
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
  await writeMessage('A fresh perspective');
  assert.equal(await evaluate(`!!document.querySelector('textarea[name=text]')||document.body.textContent.includes('Open content builder')`),false);
  await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Block style"]');e.value='h1';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await toggle();
  await wait(async()=>evaluate(`!document.querySelector('#compose-preview').hidden`));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).getAttribute('aria-expanded')`),'true');
  assert(await evaluate(`document.querySelector('#compose-preview h1')?.textContent==='A fresh perspective'`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Subscriber preview fits '+width);
  await toggle();
  assert.equal(await messageText(),'A fresh perspective');
  assert(await evaluate(`!document.querySelector('input[name=mode]')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Subscriber editor fits '+width);
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'cover.png',{type:'image/png'}));const e=document.querySelector('input[aria-label="Add image"]');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(async()=>evaluate(`!!document.querySelector('input[aria-label="Image description"]')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Cover controls fit '+width);
  await toggle();
  assert(await evaluate(`document.querySelector('.send-bar .hail-button').disabled`),'Missing image description blocks sending');
  await toggle();
  await input('input[aria-label="Image description"]','A cover description');
  await input('input[aria-label="Image caption"]','A cover caption');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Remove image').click()`);
  await wait(async()=>evaluate(`!document.querySelector('input[aria-label="Image description"]')`));
  assert(await evaluate(`JSON.parse(document.querySelector('input[name=builder]').value).body.profile==='spt-2'`),'Removed image and metadata are absent from submission');
  await toggle();
  assert(await evaluate(`!document.querySelector('#compose-preview img')`),'Preview has no removed image');
  await navigate('/compose?audience=connections');
  assert(await evaluate(`!!document.querySelector('#message-text')&&!!document.querySelector('[aria-label="Text formatting"]')&&!document.querySelector('.content-builder,input[name="builder"],.builder-inspector,button[aria-label="Add call to action"]')`),'Connections uses basic formatting without block builder');
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
  await writeMessage('A personal hello');
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
  assert.equal(await messageText(),'A personal hello');
  assert.equal(await evaluate(`document.querySelectorAll('.recipient-chip').length`),2);
  assert(await evaluate(`!document.querySelector('input[name=delivery]')`));
  assert(await evaluate(`!document.querySelector('.send-bar .hail-button').disabled`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Connection editor fits '+width);
  console.log('PASS: compose editing, preview, search, delivery, retry and layout at '+width);
}

for(const width of [1440,390]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/compose');
  const input=async(selector:string,value:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await writeMessage('Unfinished message');
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'cover.png',{type:'image/png'}));const e=document.querySelector('input[aria-label="Add image"]');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(()=>evaluate(`!!document.querySelector('input[aria-label="Image description"]')`));
  const draftId=await evaluate(`document.querySelector('input[name=publicationId]').value`);
  await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='1'`));
  assert(await evaluate(`document.body.textContent.includes('Draft saved.')`),'Incomplete message and missing alt text can be saved');
  await navigate('/compose?draft='+draftId);
  await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
  assert.equal(await messageText(),'Unfinished message');
  assert(await evaluate(`JSON.parse(document.querySelector('input[name=builder]').value).body.assets.assets[0].data.length>0`),'Cover survives a fresh page load');
  await writeMessage('Edited draft');await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
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
  await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
  assert.equal(await messageText(),'Edited draft');
  // Another signed-in client saves a newer revision. The stale editor retains its text.
  await evaluate(`(async()=>{const draft=await(await fetch('/api/v1/account/drafts/${draftId}')).json();await fetch('/api/v1/account/drafts/${draftId}/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:draft.revision,content:draft.content})});})()`);
  await writeMessage('My unsaved changes');await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('[role=alert]')?.textContent.includes('another device')`));
  assert.equal(await messageText(),'My unsaved changes');
  console.log('PASS: draft save, reload, image persistence, update, avatar deletion, restore and stale-edit protection at '+width);
}

// Legacy draft conversion is read-only until an explicit save and retains its cover.
await navigate('/compose');
const legacyId=await evaluate(`document.querySelector('input[name=publicationId]').value`);
await evaluate(`(async()=>{const content={audience:'category',category:'general',connections:[],title:'Legacy headline',text:'Hello **world**',alt:'',caption:'Original caption',allowReply:true,header:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk-A8AAQUBAScY42YAAAAASUVORK5CYII',forward:null};const r=await fetch('/api/v1/account/drafts/${legacyId}/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,content})});if(!r.ok)throw Error('Legacy fixture save failed');})()`);
await navigate('/compose?draft='+legacyId);
await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
assert(await evaluate(`!document.querySelector('textarea')&&document.querySelector('input[name=savedHeader]').value===''`));
assert(await evaluate(`JSON.parse(document.querySelector('input[name=builder]').value).body.blocks.some(b=>b.style==='h1'&&b.children[0].text==='Legacy headline')`));
assert(await evaluate(`(async()=>{const d=await(await fetch('/api/v1/account/drafts/${legacyId}')).json();return d.revision===1&&!d.content.builder&&d.content.text==='Hello **world**';})()`),'Opening never rewrites the saved draft');
await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
await wait(()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='2'`));
assert(await evaluate(`(async()=>{const d=await(await fetch('/api/v1/account/drafts/${legacyId}')).json();return !!d.content.builder&&d.content.header===null&&d.content.title===''&&d.content.text===''&&d.content.builder.body.blocks[0].alt==='';})()`),'Explicit save writes exactly one content representation');

// Exercise the same reusable package inside the authenticated publication form.
for(const width of [1440,390]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/compose');
  await writeMessage('Literal text with ');
  await evaluate(`document.querySelector('button[aria-label="Bold"]').click()`);
  await cdp('Input.insertText',{text:'bold'});
  await evaluate(`document.querySelector('button[aria-label="Bold"]').click()`);
  await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
  const toggleSelector=width<=900?'.mobile-floating-action':'.preview-toggle';
  const toggle=async()=>{await evaluate(`document.querySelector(${JSON.stringify(toggleSelector)}).click()`);};
  assert.equal(await evaluate(`!!document.querySelector('.content-builder .preview-controls')`),false);
  await evaluate(`void(window.builderEditor=document.querySelector('[contenteditable=true]'))`);
  await wait(()=>evaluate(`!!document.querySelector('.compose-studio').dataset.builderWide`));
  await evaluate(`window.composeCanvasWidth=document.querySelector('.compose-layout').getBoundingClientRect().width`);
  if(width===1440){
    assert(await evaluate(`document.querySelector('.compose-block-settings .builder-inspector')!==null`),'settings live outside the compose form');
    assert(await evaluate(`(()=>{const form=document.querySelector('.compose-layout').getBoundingClientRect(),panel=document.querySelector('.compose-block-settings').getBoundingClientRect();return panel.left>=form.right;})()`),'desktop sidebar does not occupy editor width');
    await evaluate(`(()=>{const canvas=document.querySelector('.builder-canvas');canvas.style.minHeight='2000px';document.querySelector('.compose-studio').scrollIntoView();window.scrollBy(0,300);})()`);
    assert(await evaluate(`Math.abs(document.querySelector('.compose-block-settings').getBoundingClientRect().top-20)<2`),'sidebar stays visible while scrolling a long document');
    await evaluate(`document.querySelector('.builder-canvas').style.minHeight='';window.scrollTo(0,0)`);
  }

  await toggle();
  assert(await evaluate(`!document.querySelector('#compose-preview').hidden&&document.querySelector('.builder-editor').hidden`));
  assert(await evaluate(`document.querySelector('.compose-layout').getBoundingClientRect().width===window.composeCanvasWidth`),'preview preserves compose width');
  assert(await evaluate(`document.querySelector('#compose-preview .strong').textContent==='bold'`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Builder preview fits '+width);
  await toggle();
  assert(await evaluate(`document.querySelector('#compose-preview').hidden&&!document.querySelector('.builder-editor').hidden&&window.builderEditor===document.querySelector('[contenteditable=true]')`),'Preview keeps the editor mounted');
  await evaluate(`document.querySelector('button[aria-label="Add call to action"]').click()`);
  await evaluate(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'cover.png',{type:'image/png'}));const e=document.querySelector('input[aria-label="Add image"]');e.files=transfer.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait(()=>evaluate(`!!document.querySelector('input[aria-label="Image description"]')`));
  await toggle();
  assert(await evaluate(`document.querySelector('#compose-preview').textContent.includes('Add an image description.')`));
  assert.equal(await evaluate(`document.querySelectorAll('#compose-preview img').length`),0,'Invalid content has no stale preview');
  await toggle();
  if(width===390){
    await evaluate(`document.querySelector('.builder-settings-launch').click()`);
    assert(await evaluate(`document.querySelector('.builder-sheet').matches(':modal')`),'mobile settings open as a sheet');
  }
  await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Image description"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Builder cover');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if(width===390)await evaluate(`document.querySelector('.builder-sheet-close').click()`);
  await toggle();
  await wait(()=>evaluate(`document.querySelector('#compose-preview .preview-issues')?.textContent.includes('Add a destination URL.')`));
  assert(await evaluate(`document.querySelector('#compose-preview .preview-issues').textContent.includes('Learn more')&&!document.querySelector('#compose-preview .preview-issues').textContent.includes('Add an image description.')`),'preview names the unfinished button rather than the completed image');
  await evaluate(`document.querySelector('#compose-preview .preview-issues button').click()`);
  await wait(()=>evaluate(`document.activeElement?.getAttribute('aria-label')==='Button label'`));
  assert(await evaluate(`document.querySelector('#compose-preview').hidden`),'Edit block returns to editing');
  if(width===390)assert(await evaluate(`document.querySelector('.builder-sheet').matches(':modal')`),'Edit block opens mobile settings');
  await evaluate(`(()=>{const e=document.querySelector('input[aria-label="Call-to-action destination"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'https://example.invalid/action');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  if(width===390)await evaluate(`document.querySelector('.builder-sheet-close').click()`);
  await toggle();
  await wait(()=>evaluate(`document.querySelector('#compose-preview img')?.complete`));
  assert.equal(await evaluate(`document.querySelector('#compose-preview img').alt`),'Builder cover');
  await toggle();
  assert(await evaluate(`document.querySelector('#compose-preview').textContent.includes('Literal text with bold')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),'Embedded builder fits '+width);
  assert.equal(await evaluate(`!!document.querySelector('.content-builder input[accept="application/json,.json"],aside[aria-label="Draft recovery"]')`),false);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).filter(b=>b.textContent==='Save as Draft').length`),1);
  const draftId=await evaluate(`document.querySelector('input[name=publicationId]').value`);
  await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='1'`));
  assert(await evaluate(`JSON.parse(document.querySelector('input[name=builder]').value).body.blocks.some(b=>b.children?.some(s=>s.marks.includes('strong')))`));
  await navigate('/compose?draft='+draftId);
  await wait(()=>evaluate(`!!document.querySelector('[contenteditable=true]')`));
  assert(await evaluate(`document.querySelector('#compose-preview').textContent.includes('Literal text with bold')`));
  assert(await evaluate(`!document.querySelector('textarea[name=text]')`),'Rich draft never returns through the simple parser');
  // Existing fixture intentionally rejects publication, so the user's editor survives it.
  await evaluate(`(()=>{const e=document.querySelector('#category-search');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  await wait(()=>evaluate(`!document.querySelector('.send-bar .hail-button').disabled`));
  await evaluate(`document.querySelector('.send-bar .hail-button').click()`);
  await wait(()=>evaluate(`document.querySelector('[role=alert]')?.textContent.includes('not confirmed')`));
  assert(await evaluate(`document.querySelector('#compose-preview').textContent.includes('Literal text with bold')`));
  console.log('PASS: reusable builder conversion, save, reload, publication handoff and preserved edits at '+width);
}
for(const width of [1440,390]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/compose?audience=connections');
  await writeMessage('Hello');
  await evaluate(`document.querySelector('#message-text').select();document.querySelector('.format-toolbar button[aria-label="Bold"]').click()`);
  await wait(()=>evaluate(`document.querySelector('#message-text').value==='**Hello**'`));
  const text='**Hello** and *italic* [Site](https://example.invalid)\n\n- Item';
  await writeMessage(text);
  const toggle=()=>evaluate(`document.querySelector(${JSON.stringify(width<=900?'.mobile-floating-action':'.preview-toggle')}).click()`);
  await toggle();
  assert(await evaluate(`document.querySelector('#compose-preview .strong')?.textContent==='Hello'&&document.querySelector('#compose-preview a')?.getAttribute('href')==='https://example.invalid/'&&document.querySelector('#compose-preview li')?.textContent==='Item'`),'Connection preview keeps basic formatting');
  await toggle();
  const draftId=await evaluate(`document.querySelector('input[name=publicationId]').value`);
  await evaluate(`document.querySelector('button[formaction="?/save"]').click()`);
  await wait(()=>evaluate(`document.querySelector('input[name=draftRevision]').value==='1'`));
  await navigate('/compose?draft='+draftId);
  assert.equal(await messageText(),text,'Connection draft retains editable formatting');
  assert(await evaluate(`!document.querySelector('.content-builder,input[name="builder"],.builder-inspector')`),'Reload does not enable block builder');
  console.log('PASS: Connections basic formatting and draft save/reload at '+width);
}
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
