import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const sharedMode=process.argv.includes('--shared');
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_EMPTY_RELATIONSHIPS:"1",HAIL_DESIGN_SHARED_CONVERSATIONS:sharedMode?"1":"0"},stdout:'ignore',stderr:'inherit'});
const chrome=Bun.spawn([process.env.CHROMIUM??'chromium','--headless','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${work}`,'about:blank'],{stdout:'ignore',stderr:'ignore'});
let socket:WebSocket|undefined;
const wait=async(fn:()=>Promise<any>)=>{for(let n=0;n<150;n++){if(await fn())return;await Bun.sleep(100);}throw new Error('Timed out: '+fn.toString());};
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

const incoming=(await(await fetch(origin+'/api/v1/account/inbox')).json()).messages;
const connection=(await(await fetch(origin+'/api/v1/account/inbox?kind=connections')).json()).messages[0];
// Test replies while the fixture still has messages.
await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await cdp('Page.navigate',{url:origin+'/conversation/'+encodeURIComponent(connection.sender)+'/'+connection.messageId});
await wait(async()=>evaluate(`!!document.querySelector('button[aria-label="Reply privately"]:not(:disabled)')`));
await click('Reply privately');
await wait(async()=>evaluate(`!!document.querySelector('dialog[open] textarea')`));
await wait(async()=>evaluate(`Math.abs(document.querySelector('dialog[open]').getBoundingClientRect().bottom-innerHeight)<1`));
await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
await wait(async()=>evaluate(`!document.querySelector('dialog[open]')`));
if(sharedMode){
  await click('Reply all');
  await wait(async()=>evaluate(`!!document.querySelector('dialog[open] form[action$="?/replyAll"]')`));
  await click('Close');
}
// Move all received messages to Trash so both mailbox views are empty.
for(const m of [...incoming,connection])await fetch(origin+'/api/v1/account/inbox/'+encodeURIComponent(m.sender)+'/'+m.messageId+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
// Remove any additional connection messages too.
for(const m of (await(await fetch(origin+'/api/v1/account/inbox?kind=connections')).json()).messages)await fetch(origin+'/api/v1/account/inbox/'+encodeURIComponent(m.sender)+'/'+m.messageId+'/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
await cdp('Page.navigate',{url:origin+'/message/'+encodeURIComponent(incoming[0].sender)+'/'+incoming[0].messageId});
await wait(async()=>evaluate(`!!document.querySelector('.restore-button')`));
await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'}]});
assert(await evaluate(`(()=>{const button=document.querySelector('.restore-button'),r=button.getBoundingClientRect(),s=getComputedStyle(button);return r.width===56&&r.height===56&&s.borderRadius==='18px'&&s.color!==s.backgroundColor&&Math.abs((r.left+r.right)/2-innerWidth/2)<1;})()`),'Restore matches the shared floating button size, shape and contrast');
await fetch(origin+'/api/v1/account/trash/empty',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
for(const width of [1440,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<500});
  const heights=[];
  for(const [path,title] of [['/?view=subscriptions','Feed'],['/?view=connections','Inbox'],['/drafts','Drafts'],['/trash','Trash'],['/permissions','Subscriptions'],['/connections','Connections']]){
    await navigate(path!,title!);
    await wait(async()=>evaluate(`!!document.querySelector('.empty-symbol')`));
    heights.push(await evaluate(`document.querySelector('.empty-symbol').parentElement.getBoundingClientRect().height`));
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),title+' fits viewport');
    if(title==='Subscriptions'||title==='Connections'){
      assert(await evaluate(`document.querySelector('.empty-symbol').parentElement.textContent.includes(${JSON.stringify('No '+title.toLowerCase()+' yet.')})`));
      if(width<500){
        assert(await evaluate(`!document.querySelector('dialog[open]')`));
        await click(title==='Subscriptions'?'Add a subscription':'Add a connection');
        await wait(async()=>evaluate(`!!document.querySelector('dialog[open] form')`));
        assert(await evaluate(`document.activeElement?.closest('dialog')!==null`),'Sheet receives focus');
        await click('Close');
      }else assert(await evaluate(`Array.from(document.querySelectorAll('form')).some(f=>f.getClientRects().length>0)`),'Desktop forms stay inline');
    }
  }
  assert(heights.every(h=>h===heights[0]),'All empty states have the Feed height: '+heights);
}
await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await navigate('/permissions','Subscriptions');await click('Add a subscription');
await evaluate(`window.permissionCalls=[];const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/permissions'))window.permissionCalls.push(args[0]);return original(...args);};const input=document.querySelector('input[placeholder="sender@example.com"]');input.value='j4crev.com';input.dispatchEvent(new Event('input',{bubbles:true}));`);
await click('Continue');
await wait(async()=>evaluate(`document.querySelector('.toast-stack')?.textContent.includes('Enter a valid Hail address')`));
assert.deepEqual(await evaluate('window.permissionCalls'),[],'Invalid address never reaches the provider');
assert(await evaluate(`document.querySelector('.toast-stack').matches(':popover-open')`),'Validation toast visible over mobile sheet');
assert(await evaluate(`(()=>{const b=document.querySelector('.toast button'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`),'Toast remains interactive over a modal sheet');
// Simulate a reviewed sender and a cancelled passkey, without performing any real authorization.
await evaluate(`window.passkeyCalls=0;Object.defineProperty(navigator.credentials,'get',{configurable:true,writable:true,value:async()=>{window.passkeyCalls++;throw new DOMException('Cancelled','NotAllowedError');}});
const prepared={requestId:'00000000-0000-4000-8000-000000000001',action:'allow',expiresAt:new Date(Date.now()+300000).toISOString(),approved:false,result:null,options:{challenge:'AQID',rpId:'localhost',userVerification:'preferred'},permission:{grant_id:'00000000-0000-4000-8000-000000000002',revision:1,grantor:'did:plc:'+'a'.repeat(24),grantee:'did:plc:'+'b'.repeat(24),expires_at:null,scope:[{type:'categories',values:['general']}],consent_context:{grantee_address:'sender@example.com'}}};
window.permissionPrepared=prepared;const reviewFetch=window.fetch;window.fetch=(...args)=>{const path=String(args[0]);if(path.includes('/permissions/'))return Promise.resolve(Response.json(path.endsWith('/review')?{address:'sender@example.com',did:'did:plc:'+'b'.repeat(24),displayName:'Sender',addressDigest:'address',profileDigest:'profile',offersUncategorized:false,categories:[{id:'general',label:'General'}]}:prepared));return reviewFetch(...args);};
const reviewedInput=document.querySelector('input[placeholder="sender@example.com"]');reviewedInput.value='sender@example.com';reviewedInput.dispatchEvent(new Event('input',{bubbles:true}));`);
await click('Continue');await wait(async()=>evaluate(`!!document.querySelector('input[type="checkbox"][value="general"]')`));
await evaluate(`document.querySelector('input[type="checkbox"][value="general"]').click()`);await click('Subscribe');
await wait(async()=>evaluate(`window.passkeyCalls===1&&document.querySelector('.toast-stack').textContent.includes('Passkey confirmation')`));
assert(await evaluate(`!document.querySelector('[aria-label="Permission confirmation"]')`),'No duplicate review step');
await click('Subscribe');await wait(async()=>evaluate('window.passkeyCalls===2'));
// A changed identity still requires explicit acknowledgment before passkey authorization.
await click('Cancel');
await evaluate(`window.permissionPrepared.previousDids=['did:plc:'+'c'.repeat(24)]`);
await click('Continue');await wait(async()=>evaluate(`!!document.querySelector('input[type="checkbox"][value="general"]')`));
await evaluate(`document.querySelector('input[type="checkbox"][value="general"]').click()`);await click('Subscribe');
await wait(async()=>evaluate(`document.querySelector('dialog[open]').textContent.includes('I checked this different identity')`));
assert.equal(await evaluate('window.passkeyCalls'),2,'Identity changes do not silently authorize');
await evaluate(`Array.from(document.querySelectorAll('dialog input[type="checkbox"]')).find(input=>input.value!=='general').click()`);
await click('Subscribe');await wait(async()=>evaluate('window.passkeyCalls===3'));
// Finish a mocked passkey ceremony and verify the sheet closes with a success toast.
await evaluate(`navigator.credentials.get=async()=>({id:'AQID',rawId:new Uint8Array([1,2,3]).buffer,type:'public-key',authenticatorAttachment:'platform',response:{authenticatorData:new Uint8Array([1]).buffer,clientDataJSON:new Uint8Array([1]).buffer,signature:new Uint8Array([1]).buffer,userHandle:null},getClientExtensionResults:()=>({})});
const commitFetch=window.fetch;window.fetch=(...args)=>String(args[0]).endsWith('/permissions/commit')?Promise.resolve(Response.json({...window.permissionPrepared,approved:true,result:{grantId:window.permissionPrepared.permission.grant_id,revision:1,status:'active',publication:'durable'}})):commitFetch(...args);`);
await click('Subscribe');
await wait(async()=>evaluate(`!document.querySelector('dialog[open]')&&document.querySelector('.toast-stack').textContent.includes('Subscribed.')`));
console.log('PASS: matched empty states at desktop/mobile widths, mobile forms/replies, Restore styling, validation toast, direct passkey and cancellation retry');
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
