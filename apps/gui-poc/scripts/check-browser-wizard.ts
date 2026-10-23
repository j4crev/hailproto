// Built GUI + Chromium + virtual WebAuthn; local API fixtures, no public writes or mail.
import {strict as assert} from "node:assert";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {createRequire} from "node:module";
import {createSignupBackup} from "../src/lib/signup-recovery.js";
import {assureValidSig,didForCreateOp} from "@did-plc/lib";
import {cidForCbor} from "@atproto/common";
import {createWebCryptoSigner,signPayload,encodeBase64Url,toDiagnosticJson,type HailGrant} from "@hailproto/codec";
import {createApp} from "../../server/src/app.js";
import type {AppConfig} from "../../server/src/config.js";
const {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse}=
  createRequire(new URL("../../server/package.json",import.meta.url))("@simplewebauthn/server");
const work=await mkdtemp(join(process.env.OPENCODE_TMP_DIR||"/tmp/opencode","hail-wizard-proof-"));
const provider=await createSignupBackup(),messaging=await createSignupBackup();
let gui:ReturnType<typeof Bun.spawn>|undefined,chrome:ReturnType<typeof Bun.spawn>|undefined,socket:WebSocket|undefined;
let passed=false;
let prepared:any=null,state="prepared",operation:any=null,enrolled=false,retired=false,authenticated=false,challenge="",credential:any;
let did:string|null=null;const sessionToken="hails_"+"A".repeat(43);
let setupId="",setupToken="",enrollmentToken="",secret="",invitation="fixture-invitation",publicationAttempts=0,prepareCalls=0;
const browserErrors:string[]=[];
const requests:{path:string;body:string;authorization:string}[]=[];
const policy={provider:"https://provider.example",monitorOrigin:"https://monitor.example",monitorKey:messaging.vault.identity.publicDidKey};
const permissionSigner=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),peerDid="did:plc:"+"b".repeat(24),peerAddress="peer@peer.example.com";
let allowed:HailGrant|null=null,allowedCose="",allowedDigest="";
const approvals=new Map<string,{action:string;payload:HailGrant;challenge:string;approved:boolean;result:unknown}>();
const incomingId="019a15fd-2bd0-7433-8afa-bd0355e0608d";
let incoming=false,replyPosts=0,replied:any=null,guiProxy:ReturnType<typeof createApp>;
const textBody=(text:string)=>({version:1,profile:"spt-1",blocks:[{_type:"block",_key:"b1",style:"normal",markDefs:[],children:[{_type:"span",_key:"s1",text,marks:[]}]}]});
const incomingMessage=()=>({messageId:incomingId,sender:peerDid,senderAddress:peerAddress,recipient:did,category:"updates",deliveredAt:new Date().toISOString(),
  body:textBody("One-time reply browser transport test"),reply:{allowed:true,until:Math.floor(Date.now()/1000)+86400},replyAvailable:replyPosts===0});
const permissionPayload=(id:string):HailGrant=>({type:"hail.grant",version:1,grant_id:id,revision:1,previous:null,grantor:did!,grantee:peerDid,
  scope:[{type:"categories",values:["updates"]}],status:"active",issued_at:Math.floor(Date.now()/1000),updated_at:Math.floor(Date.now()/1000),expires_at:Math.floor(Date.now()/1000)+30*86400,
  consent_context:{grantee_address:peerAddress,address_binding_hash:{algorithm:"sha-256",value:new Uint8Array(32)},sender_profile_hash:{algorithm:"sha-256",value:new Uint8Array(32)}},key_id:did!+"#hail-identity"});
const actionSummary=(id:string)=>{const row=approvals.get(id)!;return {requestId:id,action:row.action,approved:row.approved,result:row.result,
  expiresAt:new Date(Date.now()+300_000).toISOString(),permission:toDiagnosticJson("hail.grant",row.payload),options:row.approved?null:{challenge:row.challenge,rpId:"localhost",userVerification:"required",allowCredentials:[{id:credential.id,type:"public-key"}]}};};
const reserved=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()});const guiPort=reserved.port!;reserved.stop(true);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"no-store","Content-Type":"application/json"}});
function summary(){return {type:"hail.signup",version:1,signupId:setupId,accountId:prepared.accountId,address:prepared.address,did,state,
  expiresAt:new Date(Date.now()+86400_000).toISOString(),preparation:prepared,enrollmentExpiresAt:new Date(Date.now()+600_000).toISOString()};}
const server=Bun.serve({hostname:"::",port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(!path.startsWith("/api/")){
    try{return await guiProxy.fetch(request);}
    catch{return new Response("GUI starting",{status:503});}
  }
  const body=await request.text();requests.push({path,body,authorization:request.headers.get("Authorization")??""});const input=body?JSON.parse(body):{};
  if(path===`/api/v1/account/inbox/${encodeURIComponent(peerDid)}/${incomingId}`||path===`/api/v1/account/inbox/${peerDid}/${incomingId}`)return json(incomingMessage());
  if(path==="/api/v1/account/messages"){
    assert.equal(input.replyTo,incomingId);assert.equal(input.text,"Browser transport reply");assert.equal(replyPosts,0);replyPosts++;
    replied={messageId:input.messageId,sender:did,recipient:peerDid,recipientAddress:peerAddress,category:null,createdAt:new Date().toISOString(),
      state:"delivered",revision:2,reason:null,retryAt:null,body:textBody(input.text)};return json({messageId:input.messageId,state:"delivered"});
  }
  if(path.startsWith("/api/v1/account/sent/")&&replied)return json(replied);
  if(path.startsWith("/api/v1/account/permissions/")){
    assert(request.headers.get("Cookie")?.includes("hail_session="+sessionToken));
    const step=path.split("/").at(-1)!;
    if(step==="review"){assert.equal(input.sender,peerAddress);if(input.senderDid)assert.equal(input.senderDid,peerDid);
      return json({address:peerAddress,did:peerDid,displayName:"Test sender",addressDigest:"A".repeat(43),profileDigest:"A".repeat(43),offersUncategorized:false,categories:[{id:"updates",label:"Updates"}]});}
    if(step==="prepare"){
      assert(["allow","revoke"].includes(input.action));
      if(input.action==="allow"){assert.equal(input.senderDid,peerDid);assert.deepEqual(input.scope,{type:"categories",values:["updates"]});assert(!allowed);}
      else assert(allowed?.status==="active");
      const options=await generateAuthenticationOptions({rpID:"localhost",userVerification:"required",allowCredentials:[{id:credential.id}]});
      approvals.set(input.requestId,{action:input.action,payload:input.action==="allow"?{...permissionPayload("019a15fd-2bd0-7433-8afa-bd0355e0608c"),expires_at:input.expiresAt}:allowed!,challenge:options.challenge,approved:false,result:null});
      return json(actionSummary(input.requestId));
    }
    if(step==="commit"){
      const row=approvals.get(input.requestId)!;assert(row);
      if(!row.approved){const result=await verifyAuthenticationResponse({response:input.response,expectedChallenge:row.challenge,expectedOrigin:origin,expectedRPID:"localhost",credential,requireUserVerification:true});
        assert(result.verified);credential.counter=result.authenticationInfo.newCounter;row.approved=true;}
      allowed=row.action==="allow"?row.payload:{...row.payload,status:"revoked",revision:row.payload.revision+1,previous:Buffer.from(allowedDigest,"base64url"),updated_at:row.payload.updated_at+1};
      const raw=await signPayload("hail.grant",allowed,createWebCryptoSigner(did!+"#hail-identity",permissionSigner.privateKey));
      allowedCose=encodeBase64Url(raw);allowedDigest=encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(raw))));
      row.result={grantId:allowed.grant_id,revision:allowed.revision,status:allowed.status,publication:"durable"};return json(actionSummary(input.requestId));
    }
    if(approvals.has(step))return json(actionSummary(step));
  }
  if(path==="/api/v1/account/grants")return json({grants:allowed?[{grantId:allowed.grant_id,localRole:"grantor",status:allowed.status}]:[],next:null});
  if(path.startsWith("/api/v1/account/grants/")&&allowed)return json({type:"hailp.grant",version:1,cose:allowedCose,digest:allowedDigest,localRole:"grantor"});
  if(path==="/api/v1/account"||path==="/api/v1/account/inbox"){
    assert(retired&&request.headers.get("Cookie")?.includes("hail_session="+sessionToken),"Inbox must use the completed account's session");
    return json(path.endsWith("/inbox")?{messages:incoming?[incomingMessage()]:[],next:null}:{type:"hailp.account",version:1,provider:policy.provider,accountId:prepared.accountId,
      address:prepared.address,did,migrationState:null,custodyProfile:"managed",monitorVerificationMode:"reduced-assurance-alpha-v1",managedProfileVersion:"hail-managed-custody-v1",
      identityPublicKey:prepared.userIdentityKey,ownerRecoveryPublicKey:prepared.userRecoveryKey,scopes:["account:read","grants:read","messages:read","messages:write"]});
  }
  if(path==="/api/v1/signup/check-address")return json({address:input.address,available:true});
  if(path==="/api/v1/signup"){
    prepareCalls++;setupId=input.signupId;setupToken=request.headers.get("Authorization")!.slice(7);
    prepared={accountId:crypto.randomUUID(),address:input.address,userRecoveryKey:input.recoveryKey,userIdentityKey:provider.vault.identity.publicDidKey,
      providerRotationKey:provider.vault.recovery.publicDidKey,providerMessagingKey:messaging.vault.identity.publicDidKey,sourceServiceBase:policy.provider+"/hail",
      custodyProfile:"managed",managedProfileVersion:"hail-managed-custody-v1",monitorAssurance:"reduced-assurance-alpha-v1",monitorOrigin:policy.monitorOrigin,monitorPublicKey:policy.monitorKey};
    return json(summary());
  }
  if(path===`/api/v1/signup/${setupId}`)return retired?json({},403):json(summary());
  if(path==="/api/v1/signup-email/start")return json({verified:false,expiresAt:Date.now()+600_000});
  if(path==="/api/v1/signup-email/verify"){assert.equal(input.code,"12345678");return json({verified:true,expiresAt:Date.now()+600_000});}
  if(path===`/api/v1/signup/${setupId}/advance`){
    publicationAttempts++;enrollmentToken=input.enrollmentToken;
    if(input.operation){await assureValidSig([prepared.userRecoveryKey],input.operation);if(operation)assert.deepEqual(input.operation,operation);operation=input.operation;}
    assert(operation,"Expected retained signed genesis");
    did=await didForCreateOp(operation);
    assert((await cidForCbor(operation)).toString().startsWith("b"));
    state=publicationAttempts===1?"awaiting-monitor":"passkey-enrollment";
    return json(summary(),publicationAttempts===1?202:200);
  }
  if(path==="/api/v1/auth/passkeys/recovery/options"){
    assert.equal(input.token,enrollmentToken);
    const options=await generateRegistrationOptions({rpName:"Hail test",rpID:"localhost",userName:prepared.address,userID:new TextEncoder().encode(prepared.accountId),attestationType:"none"});
    challenge=options.challenge;return json({options,challengeId:crypto.randomUUID()});
  }
  if(path==="/api/v1/auth/passkeys/recovery"){
    const result=await verifyRegistrationResponse({response:input.response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:"localhost",requireUserVerification:true});
    assert(result.verified);credential=result.registrationInfo.credential;enrolled=true;state="sign-in-required";return json({created:true});
  }
  if(path==="/api/v1/auth/passkeys/authentication/options"){
    assert(enrolled);const options=await generateAuthenticationOptions({rpID:"localhost",userVerification:"required"});challenge=options.challenge;return json({options,challengeId:crypto.randomUUID()});
  }
  if(path==="/api/v1/auth/passkeys/authentication"){
    const result=await verifyAuthenticationResponse({response:input.response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:"localhost",credential,requireUserVerification:true});
    assert(result.verified);credential.counter=result.authenticationInfo.newCounter;authenticated=true;const response=json({authenticated:true});
    response.headers.set("Set-Cookie",`hail_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`);return response;
  }
  if(path===`/api/v1/signup/${setupId}/complete`){assert(authenticated);retired=true;return json({state:"complete",signupId:setupId});}
  return json({},404);
}});
const origin=`http://localhost:${server.port}`;
guiProxy=createApp({publicOrigin:origin,providerId:"browser-fixture",thinGuiOrigin:`http://127.0.0.1:${guiPort}`} as AppConfig);
const wait=async(fn:()=>Promise<boolean>,description:string)=>{const end=Date.now()+25_000;while(Date.now()<end){if(await fn())return;await Bun.sleep(100);}throw new Error("Timed out: "+description);};
try{
  gui=Bun.spawn(["bun","build/index.js"],{cwd:new URL("..",import.meta.url).pathname,env:{...process.env,HOST:"127.0.0.1",PORT:String(guiPort),ORIGIN:origin,
    HAIL_GUI_SIGNUP:"true",HAIL_GUI_PROVIDER:policy.provider,HAIL_GUI_API_ORIGIN:origin,HAIL_GUI_ORIGIN:origin,
    ALPHA_SIGNUP_MONITOR_ORIGIN:policy.monitorOrigin,SIGNUP_MONITOR_PUBLIC_KEY:policy.monitorKey},stdout:"ignore",stderr:"pipe"});
  let startupStatus="";
  try{await wait(async()=>{try{const r=await fetch(origin+"/signup");startupStatus=String(r.status)+" "+(await r.text()).slice(0,300);return r.ok;}catch(error){startupStatus=String(error);return false;}},"GUI startup");}
  catch(error){console.error(startupStatus);throw error;}
  chrome=Bun.spawn([process.env.CHROMIUM||"chromium","--headless","--disable-gpu","--disable-background-networking","--no-first-run","--no-default-browser-check",
    "--remote-debugging-port=0",`--user-data-dir=${work}/profile`,"about:blank"],{stdout:"ignore",stderr:"pipe"});
  let debugPort="";await wait(async()=>{try{debugPort=(await readFile(join(work,"profile/DevToolsActivePort"),"utf8")).split("\n")[0]!;return !!debugPort;}catch{return false;}},"Chromium startup");
  const targets=await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as any[];
  socket=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
  await new Promise<void>((resolve,reject)=>{socket!.onopen=()=>resolve();socket!.onerror=reject;});
  let sequence=0;const waiting=new Map<number,{resolve:(v:any)=>void;reject:(v:any)=>void}>();
  socket.onmessage=event=>{const value=JSON.parse(String(event.data)),pending=waiting.get(value.id);if(pending){waiting.delete(value.id);value.error?pending.reject(new Error(JSON.stringify(value.error))):pending.resolve(value.result);}
    if(value.method==="Runtime.exceptionThrown")browserErrors.push(value.params.exceptionDetails.exception?.description??value.params.exceptionDetails.text);
    if(value.method==="Log.entryAdded"&&value.params.entry.level==="error")browserErrors.push(value.params.entry.text);};
  const cdp=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});socket!.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression:string)=>{const result=await cdp("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error("Browser evaluation failed: "+(result.exceptionDetails.exception?.description??result.exceptionDetails.text));return result.result.value;};
  const has=async(text:string)=>evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})??false`);
  const noPrematureSignIn=async()=>assert(await evaluate(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Sign in with a created passkey and finish setup')`),"Sign-in offered before confirmed passkey enrollment");
  const click=async(text:string)=>{await wait(async()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`),"button: "+text);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);};
  const fill=async(label:string,value:string)=>evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  async function file(label:string,path:string){const {root}=await cdp("DOM.getDocument"),{nodeId}=await cdp("DOM.querySelector",{nodeId:root.nodeId,selector:`input[type=file][data-proof="${label}"]`});assert(nodeId);await cdp("DOM.setFileInputFiles",{nodeId,files:[path]});}
  const upload=async(label:string,path:string)=>{await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');e.dataset.proof='upload';})()`);await file("upload",path);};
  await cdp("Page.enable");await cdp("Runtime.enable");await cdp("Log.enable");await cdp("WebAuthn.enable");
  if(process.env.HAIL_WIZARD_MOBILE==="true")await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
  await cdp("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await cdp("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:work});
  await cdp("Page.navigate",{url:origin+"/signup#invitation="+invitation});
  await wait(()=>has("Start with an invitation"),"signup render");
  await wait(async()=>evaluate("location.hash==='' && document.querySelector('input[type=password]')?.value===''") ,"signup hydration");
  await fill("Your Hail address","alice");await fill("External security-alert email","alice@example.net");
  await evaluate(`document.querySelector('input[type=checkbox]').click()`);
  await click("Create recovery kit locally");await wait(()=>has("Save and verify recovery"),"local key generation");
  secret=await evaluate("document.querySelector('.secret').textContent");assert.equal(secret.length,43);
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Recovery screen overflows viewport");
  await click("Save encrypted recovery backup");
  await wait(async()=>{try{return (await readdir(work)).includes("hail-recovery.vault.json");}catch{return false;}},"vault download");
  await evaluate(`document.querySelector('input[type=checkbox]').click()`);
  await upload("Reopen the saved recovery backup",join(work,"hail-recovery.vault.json"));
  await fill("Secret from your separate copy","A".repeat(43));await click("Verify saved recovery kit");
  await wait(()=>has("could not finish"),"wrong-secret refusal");assert.equal(prepareCalls,0);
  await fill("Secret from your separate copy",secret);await click("Verify saved recovery kit");await wait(()=>has("Save encrypted setup file"),"kit verification");
  await click("Save encrypted setup file");await click("Check and reserve this address");await wait(()=>has("Verify external security alerts"),"address reservation");
  await click("Send code / check verification");await wait(()=>has("Check your external inbox"),"email start");
  await fill("Eight-digit code","12345678");await click("Verify email");await wait(()=>has("Review and sign your exact identity"),"email verification");
  await fill("Recovery secret (used locally once to sign)",secret);await click("Sign this identity locally");await wait(()=>has("Save encrypted signed setup file"),"genesis signing");
  await click("Save account recovery backup");await noPrematureSignIn();
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Identity screen overflows viewport");
  await click("Save encrypted signed setup file");
  const checkpoint=await evaluate("localStorage.getItem('hail.pending-signup.v1')");let signedFile="";
  await wait(async()=>{for(const name of await readdir(work))if(name.startsWith("hail-pending-setup")&&name.endsWith(".json")&&await readFile(join(work,name),"utf8")===checkpoint){signedFile=name;return true;}return false;},"signed setup download");
  // Simulate storage eviction: reopen the actual downloaded signed file.
  const stored=await evaluate("localStorage.getItem('hail.pending-signup.v1')");assert(!stored.includes(secret)&&!stored.includes(setupToken));
  await evaluate("localStorage.clear()");
  await cdp("Page.reload");await wait(()=>has("Start with an invitation"),"clean-browser file resume");
  await upload("Pending setup file",join(work,signedFile));
  await fill("Separate recovery secret",secret);await click("Continue setup");await wait(()=>has("Publish and activate this identity"),"resume exact genesis");
  await click("Publish and activate this identity");await wait(()=>has("awaiting-monitor"),"monitor wait");
  await noPrematureSignIn();
  // A reload must not create another account/identity while monitoring is pending.
  await cdp("Page.reload");await wait(()=>has("Encrypted setup was found"),"monitor resume");
  await fill("Separate recovery secret",secret);await click("Continue setup");await wait(()=>has("Retry activation with original state"),"pending monitor state");
  await click("Retry activation with original state");await wait(()=>has("Create your passkey"),"activation");
  await noPrematureSignIn();assert(!requests.some(r=>r.path.includes("authentication")),"Authentication requested before enrollment");
  await click("Check passkey registration status");await wait(()=>has("Passkey registration is not confirmed"),"unenrolled status check");await noPrematureSignIn();
  await click("Create passkey");await wait(()=>has("sign-in-required"),"real WebAuthn registration");
  await cdp("Page.reload");await wait(()=>has("Encrypted setup was found"),"post-passkey resume");
  await fill("Separate recovery secret",secret);await click("Continue setup");await wait(()=>has("sign-in-required"),"retained passkey state");
  await click("Save account recovery backup");
  await click("Sign in with a created passkey and finish setup");await wait(()=>has("Your account is ready"),"fresh passkey login and retirement");
  assert(retired&&authenticated&&enrolled);assert.equal(prepareCalls,1);assert.equal(publicationAttempts,2);
  assert.equal(await evaluate("localStorage.getItem('hail.pending-signup.v1')"),null);
  await wait(async()=> (await readdir(work)).includes("hail-account-recovery.vault.json"),"final identity-bound backup");
  const finalBackup=JSON.parse(await readFile(join(work,"hail-account-recovery.vault.json"),"utf8"));assert(/^did:plc:[a-z2-7]{24}$/.test(finalBackup.did));
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Open your inbox').click()`);
  await wait(()=>has("No messages yet"),"completed alpha account inbox");
  assert(await has("alice@provider.example"));
  // Follow the same-document route out of sensitive signup into a message.
  // A full Page.navigate here would conceal a leaked signup form-action CSP.
  incoming=true;
  const messagePath=`/message/${encodeURIComponent(peerDid)}/${incomingId}`;
  await evaluate(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(messagePath)};a.textContent='Open received test';document.body.append(a);a.click();})()`);
  await wait(()=>has("Send reply"),"incoming one-time reply after signup navigation");
  await evaluate(`(()=>{const e=document.querySelector('textarea[name=text]');e.value='Browser transport reply';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("Send reply");
  await wait(async()=>evaluate("location.pathname.startsWith('/sent/') && !!document.querySelector('[aria-label=\"Status: delivered\"]')"),"native reply form through provider proxy and redirect to Sent");
  assert.equal(replyPosts,1);
  await cdp("Page.navigate",{url:origin+messagePath});await wait(()=>has("This reply invitation has expired or was already used"),"consumed one-time reply");
  assert.equal(replyPosts,1);
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("Message feed"),"return to inbox");
  await evaluate(`[...document.querySelectorAll('nav a')].find(a=>a.textContent.trim()==='Allowed senders').click()`);
  await wait(()=>has("No permissions on this page"),"allowed-sender list");
  await fill("Potential sender's Hail address",peerAddress);await click("Review sender");await wait(()=>has("Test sender"),"verified sender review");
  await evaluate(`document.querySelector('fieldset input[value=updates]').click()`);
  await click("Review permission before approving");await wait(()=>has("Confirm allowed sender"),"exact permission review");
  assert.equal(allowed,null);assert(await has("alice@provider.example"));
  await click("Allow sender with my passkey");await wait(()=>has("Review revocation"),"passkey-approved permission saved");
  assert.equal(allowed!.status,"active");await click("Review revocation");await wait(()=>has("Confirm revocation"),"revocation review");
  await click("Revoke sender with my passkey");await wait(()=>has("revoked"),"passkey-confirmed revocation");
  assert.equal(allowed!.status,"revoked");
  await click("Show my sender QR");assert(await evaluate("!!document.querySelector('svg[role=img] path')"));
  const qrRequests=requests.filter(r=>r.path.endsWith("/permissions/prepare")).length;
  await cdp("Page.navigate",{url:origin+"/permissions#"+new URLSearchParams({sender:peerAddress,did:peerDid})});
  await wait(()=>has("QR identity pin:"),"scanned sender QR prefill");
  assert.equal(await evaluate(`document.querySelector('input[placeholder="canary-prov@haili.app"]').value`),peerAddress);
  assert.equal(requests.filter(r=>r.path.endsWith("/permissions/prepare")).length,qrRequests,"Opening a QR must not prepare or approve a permission");
  await click("Review sender");await wait(()=>has("Test sender"),"QR and typed address share the same review");
  for(const req of requests){assert(!req.body.includes(secret),"Recovery secret uploaded");assert(!req.body.includes('"ciphertext"'),"Recovery vault uploaded");}
  assert(requests.filter(r=>r.authorization).every(r=>r.authorization==="Bearer "+setupToken||r.path.endsWith("check-address")));
  passed=true;
  console.info("PASS: Chromium signup/inbox, sender permissions and native one-time reply through the real provider GUI proxy (local API fixtures only)");
}finally{
  socket?.close();chrome?.kill();gui?.kill();server.stop(true);
  if(chrome)await chrome.exited;if(gui)await gui.exited;
  if(!passed&&gui)console.error((await new Response(gui.stderr).text()).slice(-2000));
  if(!passed)console.error(browserErrors.slice(-5).join("\n"));
  provider.recoverySecret.fill(0);messaging.recoverySecret.fill(0);secret="";
  await rm(work,{recursive:true,force:true});
}
