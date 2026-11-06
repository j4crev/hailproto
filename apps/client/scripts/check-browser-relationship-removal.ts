import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"0",HAIL_DESIGN_EMPTY_RELATIONSHIPS:"0",HAIL_DESIGN_SHARED_CONVERSATIONS:"0"},stdout:'ignore',stderr:'inherit'});
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

// Use pointer events to catch floating controls covering the selection action.
const tap=async(selector:string)=>{
  const point=await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
};
for(const width of [390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
  await navigate('/connections','Connections');
  await wait(async()=>evaluate(`!!document.querySelector('[aria-label="Your connections"] button[aria-pressed]:not(:disabled)')`));
  await tap('[aria-label="Your connections"] button[aria-pressed]');
  assert(await evaluate(`!document.querySelector('.mobile-floating-action')`),'Selection hides Add connection');
  await evaluate(`window.prepareCalls=0;const original=window.fetch;window.fetch=async(...args)=>{
    if(String(args[0]).endsWith('/connections/prepare')){
      window.prepareCalls++;
      const input=JSON.parse(args[1].body);
      await new Promise(resolve=>window.releasePrepare=resolve);
      if(window.failPrepare)return Response.json({error:'Temporarily unavailable'},{status:503});
      return Response.json({requestId:input.requestId,action:'disconnect-batch',review:{connections:input.connectionIds.map(id=>({connectionId:id,did:'did:plc:'+'e'.repeat(24),address:'alex@example.com'}))},expiresAt:new Date(Date.now()+300000).toISOString(),result:null,options:{challenge:'AQID',rpId:'localhost'}});
    }
    return original(...args);
  };`);
  await tap('[aria-label="Connection actions"] .hail-button-secondary');
  await wait(async()=>evaluate('!!window.releasePrepare'));
  assert(await evaluate(`!document.querySelector('dialog[open]')`),'Preparing removal must not open the add form');
  await evaluate('window.releasePrepare()');
  try{await wait(async()=>evaluate(`!!document.querySelector('dialog[open] [aria-label="Connections to remove"]')`));}catch(error){console.error(await evaluate(`({text:document.body.innerText,dialog:document.querySelector(".mobile-sheet")?.outerHTML,calls:window.prepareCalls})`));throw error;}
  assert(await evaluate(`document.querySelector('dialog[open]').getAttribute('aria-label')==='Remove connection'`),'Removal sheet describes the active action');
  assert(await evaluate(`!document.querySelector('.mobile-floating-action')&&!document.querySelector('dialog[open] form')`),'No overlapping Add control or form');
  assert(await evaluate(`document.querySelectorAll('dialog[open] [aria-label="Connection action confirmation"] > p').length===0`),'Managed removal shows the selected identities and actions without extra paragraphs');
  await click('Close');
  await wait(async()=>evaluate(`!document.querySelector('dialog[open]')`));
  await tap('[aria-label="Connection actions"] .hail-button-secondary');
  try{await wait(async()=>evaluate(`!!document.querySelector('dialog[open] [aria-label="Connections to remove"]')`));}catch(error){console.error(await evaluate(`({text:document.body.innerText,dialog:document.querySelector(".mobile-sheet")?.outerHTML,calls:window.prepareCalls})`));throw error;}
  assert.equal(await evaluate('window.prepareCalls'),1,'Reopening resumes the existing review');
  await click('Cancel');
  await wait(async()=>evaluate(`!document.querySelector('dialog[open]')&&!document.querySelector('[aria-label="Connection actions"] button:disabled')`));
  // A failed prepare leaves the selection actionable, without opening add forms.
  await evaluate('window.failPrepare=true;window.releasePrepare=null');
  await tap('[aria-label="Connection actions"] .hail-button-secondary');
  await wait(async()=>evaluate('!!window.releasePrepare'));await evaluate('window.releasePrepare()');
  await wait(async()=>evaluate(`!document.querySelector('[aria-label="Connection actions"] .hail-button-secondary').disabled`));
  assert(await evaluate(`!document.querySelector('dialog[open]')`));
  await click('Clear selection');await click('Add a connection');
  await wait(async()=>evaluate(`!!document.querySelector('dialog[open] form')`));await click('Close');

  for(const count of [1,2]){
    await navigate('/permissions','Subscriptions');
    await wait(async()=>evaluate(`document.querySelectorAll('[aria-label="Subscriptions"] button[aria-pressed]:not(:disabled)').length>=3`));
    // The first fixture subscription has multiple categories; use the other two.
    for(let index=2;index<2+count;index++)await tap('[aria-label="Subscriptions"] article:nth-child('+index+') button[aria-pressed]');
    assert(await evaluate(`!document.querySelector('.mobile-floating-action')`),'Selection hides Add subscription');
    await evaluate(`window.passkeyCalls=0;window.releasePrepare=null;window.prepared=null;
      Object.defineProperty(navigator.credentials,'get',{configurable:true,value:async()=>{window.passkeyCalls++;throw new DOMException('Cancelled','NotAllowedError');}});
      const original=window.fetch;window.fetch=async(...args)=>{
        const path=String(args[0]);
        if(path.endsWith('/permissions/prepare')){
          const input=JSON.parse(args[1].body),grants=input.grants??[{grantId:input.grantId}];
          const permissions=grants.map(grant=>({grant_id:grant.grantId,revision:1,grantor:'did:plc:'+'a'.repeat(24),grantee:'did:plc:'+'b'.repeat(24),expires_at:null,scope:[{type:'categories',values:['general']}],consent_context:{grantee_address:'sender@example.com'}}));
          window.prepared={requestId:input.requestId,action:input.grants?'revoke-batch':'revoke',permission:permissions[0],...(input.grants?{permissions}:{}),expiresAt:new Date(Date.now()+300000).toISOString(),approved:false,result:null,options:{challenge:'AQID',rpId:'localhost'}};
          await new Promise(resolve=>window.releasePrepare=resolve);
          return Response.json(window.prepared);
        }
        if(path.includes('/permissions/'))return Response.json(window.prepared);
        return original(...args);
      };`);
    await evaluate(`Array.from(document.querySelectorAll('[aria-label="Subscription actions"] button')).find(b=>b.textContent==='Unsubscribe').dataset.testAction='unsubscribe'`);
    await tap('[data-test-action="unsubscribe"]');
    await wait(async()=>evaluate('!!window.releasePrepare'));
    assert(await evaluate(`!document.querySelector('dialog[open]')&&!document.querySelector('.mobile-floating-action')`),'Unsubscribe does not open Add subscription while preparing');
    await evaluate('window.releasePrepare()');
    await wait(async()=>evaluate(`window.passkeyCalls===1&&!document.querySelector('[aria-label="Subscription actions"] button:disabled')`));
    assert(await evaluate(`!document.querySelector('dialog[open]')&&!document.querySelector('.mobile-floating-action')`),'Cancelled unsubscribe returns to selection, not add forms');
    await click('Clear selection');await click('Add a subscription');
    await wait(async()=>evaluate(`!!document.querySelector('dialog[open] form')`));await click('Close');
  }
}
console.log('PASS: mobile removal and unsubscribe keep add forms hidden, removal titles and content match the action, cancellation and failed preparation preserve selection, and pending removal can be reopened');
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
