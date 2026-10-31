import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {strict as assert} from 'node:assert';
const work=await mkdtemp('/tmp/haili-layout-');
const reserve=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
const fixturePort=reserve.port!;reserve.stop(true);
const fixture=Bun.spawn(['bun','scripts/preview-design.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,HAIL_DESIGN_PORT:String(fixturePort),HAIL_DESIGN_EXTRA_REPLIES:"35"},stdout:'ignore',stderr:'inherit'});
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
await wait(async()=>{try{return (await fetch(origin+'/api/v1/account/connection-inbox')).ok;}catch{return false;}});

async function navigate(path:string,title:string){
 await cdp('Page.navigate',{url:origin+path});
 await wait(async()=>evaluate(`document.querySelector('main h1')?.textContent===${JSON.stringify(title)} && document.readyState==='complete' && getComputedStyle(document.body).fontFamily.includes('Inter')`));
 await evaluate('document.fonts.ready');
}

const api=async()=>await(await fetch(origin+'/api/v1/account/inbox?kind=connections')).json();
const grouped=async()=>await(await fetch(origin+'/api/v1/account/connection-inbox')).json();
for(const width of [1440,390,320]){
 const initial=await api();
 for(const m of initial.messages.filter((m:any)=>!m.body.blocks.some((b:any)=>b.children?.some((s:any)=>s.text==='The photos turned out beautifully')))){
  await fetch(`${origin}/api/v1/account/inbox/${encodeURIComponent(m.sender)}/${m.messageId}/mark-unread`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 }
 const inbox=await grouped(),oldest=inbox.messages[0];
 assert.equal(oldest.conversation.unreadCount,40);assert.equal(inbox.messages.length,2);
 await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
 await navigate('/?view=connections','Inbox');
 await wait(async()=>evaluate(`document.querySelectorAll('.message-row').length===2`));
 assert(await evaluate(`document.querySelector('.message-row').textContent.includes('(40)')`));
 await evaluate(`document.querySelector('.message-row .message-link').click()`);
 await wait(async()=>evaluate(`document.querySelector('.expanded-body') && document.querySelector('.action-menu button')?.disabled===false`));
 assert.equal(await evaluate(`document.querySelector('.expanded').id`),'row-'+oldest.messageId);
 await wait(async()=>evaluate(`document.querySelectorAll('.conversation-item').length===34`));
 assert(await evaluate(`Array.from(document.querySelectorAll('.conversation-item')).filter(e=>!e.classList.contains('expanded')&&e.getBoundingClientRect().bottom>80&&e.getBoundingClientRect().bottom<=document.querySelector('.expanded').getBoundingClientRect().top).length>=2`),'Newer rows remain visible above the opened message');
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39);
 assert(await evaluate(`document.querySelector('.expanded').textContent.includes(${JSON.stringify(oldest.sender)})`));
 assert(await evaluate(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('unread above'))`),'Newer replies require no button');
 assert(await evaluate(`!document.querySelector('.expanded .message-row')`),'Expanded header replaces the list row');
 assert(await evaluate(`document.querySelector('main h1').textContent==='Saturday at the market?' && !document.querySelector('.conversation-item .message-subject') && !document.querySelector('.different-subject')`),'The shared subject appears once, without a Conversation heading');
 assert(await evaluate(`Math.abs(document.querySelector('.reading-body').getBoundingClientRect().left-document.querySelector('.expanded-header').getBoundingClientRect().left)<14`),'Reading column is aligned to the left');

 assert.equal(await evaluate(`document.querySelector('.expanded-header').textContent.split(${JSON.stringify(oldest.senderAddress)}).length-1`),1,'Sender address appears once');
 const originalTitle=await evaluate(`document.querySelector('.conversation-subject').textContent`);
 await evaluate(`document.querySelector('.conversation-subject').textContent='Saturday at the market — planning our morning together, choosing a meeting place, and everything we should bring along for a picnic afterward'`);
 assert(await evaluate(`(()=>{const h=document.querySelector('.conversation-subject'),s=getComputedStyle(h);return h.scrollHeight<=h.clientHeight+1 && s.whiteSpace==='normal' && document.querySelector('.expanded-date').getBoundingClientRect().right<=innerWidth;})()`),'Long conversation subjects remain fully visible');
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 if(width<500)assert(await evaluate(`document.querySelector('.conversation-subject').clientHeight>parseFloat(getComputedStyle(document.querySelector('.conversation-subject')).lineHeight)*2`),'Mobile subject wraps across multiple lines');
 await evaluate(`document.querySelector('.conversation-subject').textContent=${JSON.stringify(originalTitle)}`);

 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 await evaluate(`window.scrollTo(0,0)`);
 await wait(async()=>evaluate(`document.querySelectorAll('.conversation-item').length===41`));
 await evaluate(`Array.from(document.querySelectorAll('.conversation-item')).at(-1).querySelector('button.row-button').click()`);
 await wait(async()=>evaluate(`document.querySelector('.expanded')?.textContent.includes('Delivery details')`));
 assert.equal(await evaluate(`document.querySelectorAll('.expanded-body').length`),1);
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39);
 await evaluate(`document.querySelector('.conversation-item button.row-button').click()`);
 await wait(async()=> (await grouped()).messages[0].conversation.unreadCount===38);
 assert(await evaluate(`document.querySelector('.expanded').textContent.includes('maya@')`));
 assert.equal(await evaluate(`document.querySelectorAll('.expanded-body').length`),1);
 assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
 const openId=await evaluate(`document.querySelector('.expanded').id`),path=await evaluate('location.pathname');
 await evaluate(`document.querySelector('.expanded .action-menu summary').click()`);
 await evaluate(`Array.from(document.querySelectorAll('.expanded .menu-item')).find(b=>b.textContent.includes('Mark unread')).click()`);
 await wait(async()=>evaluate(`!document.querySelector('.expanded-body')`));
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 assert.equal(await evaluate('location.pathname'),path,'Mark unread stays in the conversation');
 assert.equal((await grouped()).messages[0].conversation.unreadCount,39,'Closed message remains unread');
 assert(await evaluate(`!document.getElementById(${JSON.stringify(openId)}).querySelector('.message-row').classList.contains('is-read')`));
 await evaluate(`document.getElementById(${JSON.stringify(openId)}).querySelector('button.row-button').click()`);
 await wait(async()=> (await grouped()).messages[0].conversation.unreadCount===38);
 console.log('PASS: 40 unread replies load in bounded batches on scroll, with independent read state and sent original at '+width);
}
}finally{socket?.close();chrome.kill();fixture.kill();await Promise.all([chrome.exited,fixture.exited]);await rm(work,{recursive:true,force:true});}
