import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=process.argv.includes('--shared');
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
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

async function navigate(path:string,title:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent===${JSON.stringify(title)} && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

const click=async(label:string)=>evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.getClientRects().length&&(b.getAttribute('aria-label')??b.textContent.trim())===${JSON.stringify(label)}).click()`);
const sentItems=async(trash=false)=>(await(await fetch(origin+'/api/v1/account/sent?include=sends'+(trash?'&trash=true':''))).json()).messages;
for(const width of [1440,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/sent','Sent');
  await wait(async()=>evaluate(`!document.querySelector('.mobile-cleanup').disabled`));
  for(const scheme of ['light','dark']){
    await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
    assert(await evaluate(`getComputedStyle(document.querySelector('.cleanup-menu')).display===${JSON.stringify(width<500?'none':'block')}`));
    if(width<500){
      assert(await evaluate(`(()=>{const b=document.querySelector('.mobile-cleanup'),r=b.getBoundingClientRect(),s=getComputedStyle(b);return r.width===56&&r.height===56&&Math.abs((r.left+r.right)/2-innerWidth/2)<1&&s.color!==s.backgroundColor;})()`),'Mobile cleanup matches compose size and has contrasting colors');
    }
  }
  if(width>=500)await evaluate(`document.querySelector('.cleanup-menu summary').click()`);
  await click('Move all to Trash');
  await wait(async()=>evaluate(`Boolean(document.querySelector('.cleanup-confirmation'))`));
  assert(await evaluate(`document.querySelector('.cleanup-confirmation').textContent.includes('Active sends stay in Sent.')`));
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  if(width<500)assert(await evaluate(`(()=>{const [a,b]=document.querySelectorAll('.confirmation-actions button');return a.getBoundingClientRect().width===b.getBoundingClientRect().width&&a.getBoundingClientRect().height>=44;})()`),'Mobile confirmation buttons have equal widths and usable tap targets');
  await click('Cancel');assert.equal((await sentItems()).length,1);
  if(width>=500)await evaluate(`document.querySelector('.cleanup-menu summary').click()`);
  await click('Move all to Trash');await click('Confirm');
  await wait(async()=>evaluate(`!document.querySelector('.cleanup-confirmation')&&document.querySelector('.mobile-cleanup').disabled`));
  assert.equal((await sentItems()).length,0);assert.equal((await sentItems(true)).length,1);
  await navigate('/trash','Trash');
  await wait(async()=>evaluate(`Boolean(document.querySelector('.selection-avatar:not(:disabled)'))`));
  await evaluate(`document.querySelector('.selection-avatar').click()`);
  await click('Restore selected messages');
  await wait(async()=> (await sentItems()).length===1);
  assert.equal((await sentItems(true)).length,0);
  await navigate('/sent','Sent');
  await wait(async()=>evaluate(`Boolean(document.querySelector('.selection-avatar:not(:disabled)'))`));
  await evaluate(`document.querySelector('.selection-avatar').click()`);
  await wait(async()=>evaluate(`document.querySelector('.selection-avatar').getAttribute('aria-pressed')==='true'`));
  assert(await evaluate(`Boolean(document.querySelector('.message-row.selected')) || Boolean(document.querySelector('[aria-pressed="true"]'))`));
  if(width<500)assert(await evaluate(`getComputedStyle(document.querySelector('.mobile-cleanup')).display==='none'`));
  await click('Delete selected messages');
  await wait(async()=> (await sentItems()).length===0);
  await navigate('/trash','Trash');
  await wait(async()=>evaluate(`Boolean(document.querySelector('.selection-avatar:not(:disabled)'))`));
  await evaluate(`document.querySelector('.selection-avatar').click()`);
  await click('Restore selected messages');
  await wait(async()=> (await sentItems()).length===1);
  console.log('PASS: selected Sent deletion, avatar restore, cleanup and layout at '+width);
}
await navigate('/sent','Sent');
await wait(async()=>evaluate(`!document.querySelector('.mobile-cleanup').disabled`));
// A setting change on another page must not turn Move to Trash into permanent deletion.
await fetch(origin+'/api/v1/account/message-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashEnabled:false})});
await click('Move all to Trash');await click('Confirm');
await wait(async()=>evaluate(`Boolean(document.querySelector('[role="alert"]'))`));
assert.equal((await sentItems()).length,1);
await navigate('/sent','Sent');
await wait(async()=>evaluate(`!document.querySelector('.mobile-cleanup').disabled`));
assert.equal(await evaluate(`document.querySelector('.mobile-cleanup').getAttribute('aria-label')`),'Delete all');
await wait(async()=>evaluate(`Boolean(document.querySelector('.selection-avatar:not(:disabled)'))`));
await evaluate(`document.querySelector('.selection-avatar').click()`);
await click('Delete selected messages');
await wait(async()=>evaluate(`Boolean(document.querySelector('[aria-label="Confirm deletion"]'))`));
assert.equal((await sentItems()).length,1);
await click('Cancel');
assert.equal((await sentItems()).length,1);
await click('Delete selected messages');
await click('Delete permanently');await wait(async()=> (await sentItems()).length===0);
assert.equal((await sentItems(true)).length,0);
// Seed received Trash to exercise the whole-folder permanent action.
await fetch(origin+'/api/v1/account/message-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trashEnabled:true})});
const incoming=(await(await fetch(origin+'/api/v1/account/inbox?kind=connections')).json()).messages;
for(const m of incoming)await fetch(origin+'/api/v1/account/inbox/'+encodeURIComponent(m.sender)+'/'+m.messageId+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
await navigate('/trash','Trash');await wait(async()=>evaluate(`!document.querySelector('.mobile-cleanup').disabled`));
await click('Empty Trash');await click('Cancel');
assert((await(await fetch(origin+'/api/v1/account/trash')).json()).messages.length>0);
await click('Empty Trash');await click('Confirm');
await wait(async()=>evaluate(`document.querySelector('.mobile-cleanup').disabled`));
assert.equal((await(await fetch(origin+'/api/v1/account/trash')).json()).messages.length,0);
console.log('PASS: stale setting protection, permanent Sent deletion, and Empty Trash');
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
