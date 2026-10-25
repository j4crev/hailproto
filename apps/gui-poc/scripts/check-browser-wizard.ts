// Built GUI + Chromium + virtual WebAuthn; local API fixtures, no public writes or mail.
import {strict as assert} from "node:assert";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {createRequire} from "node:module";
import {createSignupBackup} from "../src/lib/signup-recovery.js";
import {assureValidSig,didForCreateOp} from "@did-plc/lib";
import {cidForCbor} from "@atproto/common";
import {createWebCryptoSigner,signPayload,encodeBase64Url,toDiagnosticJson,fromDiagnosticJson,encodePayload,type HailGrant} from "@hailproto/codec";
import {createApp} from "../../server/src/app.js";
import type {AppConfig} from "../../server/src/config.js";
import {uuidV7} from "../../server/src/identity/uuid-v7.js";
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
const policy={provider:"https://provider.example.com",monitorOrigin:"https://monitor.example",monitorKey:messaging.vault.identity.publicDidKey};
const permissionSigner=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),peerDid="did:plc:"+"b".repeat(24),peerAddress="peer@peer.example.com";
let allowed:HailGrant|null=null,allowedCose="",allowedDigest="",generalAvailable=false;
const approvals=new Map<string,{action:string;payload:HailGrant;challenge:string;approved:boolean;result:unknown}>();
const connectionCodes:{id:string;personal:boolean;label:string;expiresAt:number|null;link:string}[]=[],connectionApprovals=new Map<string,any>();
let personalConnection=false;
const fixtureConnectionId=uuidV7(),fixtureInvitationId=uuidV7(),fixtureAdmissionToken="K".repeat(43);
const incomingId="019a15fd-2bd0-7433-8afa-bd0355e0608d";
const sendingGrantId="019a15fd-2bd0-7433-8afa-bd0355e0608e";
let sendingGrant:{payload:HailGrant;cose:string;digest:string}|null=null,composed:any=null,composePosts=0;
let publicationIntent:any=null,publicationReads=0,publicationCreated=0,composedOther:any=null;
const publicationResult=()=>({publicationId:publicationIntent.publicationId,category:publicationIntent.category,total:2,state:publicationReads>=2?"finished":"publishing",
  counts:{pending:publicationReads>=2?0:2,submitted:publicationReads>=2?2:0,blocked:0,cancelled:0,expired:0,indeterminate:0},
  delivery:{accepted:0,delivered:publicationReads>=2?1:0,"on-hold":0,failed:0,cancelled:0,indeterminate:publicationReads>=2?1:0},
  targets:[composed,composedOther].map(message=>({messageId:message.messageId,recipient:message.recipient,state:publicationReads>=2?"submitted":"pending",delivery:publicationReads>=2?message.state:null})),
  createdAt:new Date(publicationCreated).toISOString(),expiresAt:new Date(publicationCreated+86400000).toISOString()});
let incoming=false,replyPosts=0,replied:any=null,recentlyVerified=false,guiProxy:ReturnType<typeof createApp>;
const textBody=(text:string)=>({version:1,profile:"spt-1",blocks:[{_type:"block",_key:"b1",style:"normal",markDefs:[],children:[{_type:"span",_key:"s1",text,marks:[]}]}]});
const headerPng=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const incomingMessage=()=>({messageId:incomingId,sender:peerDid,senderAddress:peerAddress,recipient:did,category:"updates",deliveredAt:new Date().toISOString(),
  body:{...textBody("One-time reply browser transport test"),profile:"spt-3",assets:{version:1,assets:[{id:"hero",role:"header",media_type:"image/png",loading:"bundled",
    size:headerPng.length,width:1,height:1,data:headerPng.toString("base64url"),digest:{algorithm:"sha-256",value:"view-fixture"}}]},
    blocks:[{_type:"spt.image",asset:"hero",alt:"Bundled test header"},...textBody("One-time reply browser transport test").blocks]},
  reply:{allowed:true,until:Math.floor(Date.now()/1000)+86400},replyAvailable:replyPosts===0});
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
  assert(!request.url.includes(fixtureAdmissionToken),"Connection token leaked into an HTTP URL");
  assert(!request.headers.get("Referer")?.includes(fixtureAdmissionToken),"Connection token leaked into referrer");
  if(!path.startsWith("/api/")){
    try{return await guiProxy.fetch(request);}
    catch{return new Response("GUI starting",{status:503});}
  }
  const body=await request.text();requests.push({path,body,authorization:request.headers.get("Authorization")??""});const input=body?JSON.parse(body):{};
  if(path.startsWith("/api/v1/account/connections")){
    assert(request.headers.get("Cookie")?.includes("hail_session="+sessionToken));
    const step=path.split("/")[5];
    if(!step)return json({preview:true,codes:connectionCodes,connections:personalConnection?[{id:fixtureConnectionId,did:peerDid,address:peerAddress,connectedAt:new Date().toISOString()}]:[]});
    if(step==="review"){assert.equal(input.id,fixtureInvitationId);assert.equal(input.did,peerDid);assert.equal(input.token,fixtureAdmissionToken);
      return json({id:input.id,did:peerDid,address:peerAddress,expiresAt:null,preview:true});}
    if(step==="prepare"){
      const options=await generateAuthenticationOptions({rpID:"localhost",userVerification:"required",allowCredentials:[{id:credential.id}]});
      const review={...input,...(input.action==="connect"?{address:peerAddress}:{})};delete review.token;
      const row={requestId:input.requestId,action:input.action,review,expiresAt:new Date(Date.now()+300000).toISOString(),result:null,options};
      connectionApprovals.set(input.requestId,row);return json(row);
    }
    if(step==="commit"){
      const row=connectionApprovals.get(input.requestId);assert(row);
      if(!row.result){
        const verified=await verifyAuthenticationResponse({response:input.response,expectedChallenge:row.options.challenge,expectedOrigin:origin,expectedRPID:"localhost",credential,requireUserVerification:true});
        assert(verified.verified);credential.counter=verified.authenticationInfo.newCounter;
        if(row.action==="create"||row.action==="replace"){
          const old=connectionCodes.findIndex(code=>code.id===row.review.id);if(old>=0)connectionCodes.splice(old,1);
          const id=uuidV7();connectionCodes.push({id,personal:row.action==="replace"||row.review.personal,label:row.review.label??"Personal code",expiresAt:row.review.expiresAt??null,
            link:origin+"/connect#"+new URLSearchParams({id,did:did!,token:"M".repeat(43)})});row.result={invitationId:id};
        }else if(row.action==="revoke"){const index=connectionCodes.findIndex(code=>code.id===row.review.id);assert(index>=0);connectionCodes.splice(index,1);row.result={invitationId:row.review.id,revoked:true};}
        else{personalConnection=row.action==="connect";row.result={connectionId:fixtureConnectionId,state:personalConnection?"active":"disconnected"};}
        row.options=null;
      }
      return json(row);
    }
    return connectionApprovals.has(step)?json(connectionApprovals.get(step)):json({},404);
  }
  if(path===`/api/v1/account/inbox/${encodeURIComponent(peerDid)}/${incomingId}`||path===`/api/v1/account/inbox/${peerDid}/${incomingId}`)return json(incomingMessage());
  if(path==="/api/v1/account/messages"){
    assert.equal(input.replyTo,incomingId);assert.equal(input.text,"Browser transport reply");assert.equal(replyPosts,0);replyPosts++;
    replied={messageId:input.messageId,sender:did,recipient:peerDid,recipientAddress:peerAddress,category:null,createdAt:new Date().toISOString(),
      state:"delivered",revision:2,reason:null,retryAt:null,body:textBody(input.text)};return json({messageId:input.messageId,state:"delivered"});
  }
  if(path==="/api/v1/account/publications/audiences")return json({maxRecipients:100,categories:sendingGrant?[{category:"general",subscribers:2},{category:"updates",subscribers:1}]:[]});
  if(path==="/api/v1/account/publications"){
    if(request.method==="GET")return json({publications:publicationIntent?[{publicationId:publicationIntent.publicationId,category:publicationIntent.category,
      createdAt:new Date(publicationCreated).toISOString(),pending:publicationReads<2}]:[]});
    assert(sendingGrant);assert.equal(input.category,"general");assert.equal(input.allowReplies,false);
    assert.deepEqual(Object.keys(input).sort(),["allowReplies","body","category","publicationId"]);
    const body=fromDiagnosticJson("hail.body.spt-2",input.body);encodePayload("hail.body.spt-2",body);
    assert.deepEqual(body.blocks.map(block=>block.style),["h1","h2","normal","normal","normal","normal","blockquote","normal"]);
    if(publicationIntent){assert.deepEqual(input,publicationIntent);return json(publicationResult(),202);}
    publicationIntent=input;publicationCreated=Date.now();composePosts++;
    composed={messageId:uuidV7(),sender:did,recipient:peerDid,recipientAddress:peerAddress,category:"general",createdAt:new Date().toISOString(),state:"delivered",revision:2,reason:null,retryAt:null,body:input.body};
    composedOther={...composed,messageId:uuidV7(),recipient:"did:plc:"+"c".repeat(24),recipientAddress:null,state:"indeterminate",revision:null};
    return json(publicationResult(),202);
  }
  if(publicationIntent&&path===`/api/v1/account/publications/${publicationIntent.publicationId}`){publicationReads++;return json(publicationResult());}
  if(path===`/api/v1/account/messages/${composed?.messageId}`&&composed)return json({messageId:composed.messageId,state:composed.state,revision:composed.revision});
  for(const message of [replied,composed,composedOther])if(message&&path===`/api/v1/account/sent/${message.messageId}`)return json(message);
  if(path==="/api/v1/account/sent")return json({messages:[composed,composedOther,replied].filter(Boolean),next:null});
  if(path==="/api/v1/auth/passkeys")return json({recentlyVerified,passkeys:[{credentialId:credential.id,label:"Primary passkey",deviceType:"multiDevice",backedUp:true,
    current:true,createdAt:new Date().toISOString(),lastUsedAt:null}]});
  if(path.startsWith("/api/v1/account/permissions/")){
    assert(request.headers.get("Cookie")?.includes("hail_session="+sessionToken));
    const step=path.split("/").at(-1)!;
    if(step==="review"){assert.equal(input.sender,peerAddress);if(input.senderDid)assert.equal(input.senderDid,peerDid);
      return json({address:peerAddress,did:peerDid,displayName:"Test sender",addressDigest:"A".repeat(43),profileDigest:"A".repeat(43),offersUncategorized:!generalAvailable,categories:[{id:"updates",label:"Updates"},...(generalAvailable?[{id:"general",label:"General"}]:[])]});}
    if(step==="prepare"){
      assert(["allow","revoke"].includes(input.action));
      if(input.action==="allow"){
        assert.equal(input.senderDid,peerDid);
        assert.deepEqual(input.scope,{type:"categories",values:[generalAvailable?"general":"updates"]});
        assert(!allowed||allowed.status==="revoked");
      }
      else assert(allowed?.status==="active");
      const options=await generateAuthenticationOptions({rpID:"localhost",userVerification:"required",allowCredentials:[{id:credential.id}]});
      const proposed={...permissionPayload(generalAvailable?"019a15fd-2bd0-7433-8afa-bd0355e0608f":"019a15fd-2bd0-7433-8afa-bd0355e0608c"),
        scope:[input.scope],expires_at:input.expiresAt};
      approvals.set(input.requestId,{action:input.action,payload:input.action==="allow"?proposed:allowed!,challenge:options.challenge,approved:false,result:null});
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
  if(path==="/api/v1/account/grants")return json({grants:[...(allowed?[{grantId:allowed.grant_id,localRole:"grantor",status:allowed.status}]:[]),...(sendingGrant?[{grantId:sendingGrantId,localRole:"grantee",status:"active",expiresAt:sendingGrant.payload.expires_at}]:[])],next:null});
  if(path===`/api/v1/account/grants/${sendingGrantId}`&&sendingGrant)return json({type:"hailp.grant",version:1,cose:sendingGrant.cose,digest:sendingGrant.digest,localRole:"grantee"});
  if(path.startsWith("/api/v1/account/grants/")&&allowed)return json({type:"hailp.grant",version:1,cose:allowedCose,digest:allowedDigest,localRole:"grantor"});
  if(path==="/api/v1/account"||path==="/api/v1/account/inbox"){
    if(!request.headers.get("Cookie")?.includes("hail_session="+sessionToken))return json({},401);
    assert(retired,"Inbox must use the completed account's session");
    return json(path.endsWith("/inbox")?{messages:incoming?[incomingMessage()]:[],next:incoming&&!new URL(request.url).searchParams.has("after")?"older-page":null}:{type:"hailp.account",version:1,provider:policy.provider,accountId:prepared.accountId,
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
    assert(result.verified);credential.counter=result.authenticationInfo.newCounter;authenticated=true;recentlyVerified=true;const response=json({authenticated:true});
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
    HAIL_GUI_SIGNUP:"true",HAIL_GUI_SIGNUP_PREVIEW:"true",HAIL_GUI_PROVIDER:policy.provider,HAIL_GUI_API_ORIGIN:origin,HAIL_GUI_ORIGIN:origin,
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
  const styles=async(selector:string,properties:string[])=>evaluate(`(()=>{const style=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return ${JSON.stringify(properties)}.map(property=>style[property]);})()`);
  const noPrematureSignIn=async()=>assert(await evaluate(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Sign in with a created passkey and finish setup')`),"Sign-in offered before confirmed passkey enrollment");
  const click=async(text:string)=>{await wait(async()=>evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`),"button: "+text);
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);};
  const fill=async(label:string,value:string)=>evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  async function file(label:string,path:string){const {root}=await cdp("DOM.getDocument"),{nodeId}=await cdp("DOM.querySelector",{nodeId:root.nodeId,selector:`input[type=file][data-proof="${label}"]`});assert(nodeId);await cdp("DOM.setFileInputFiles",{nodeId,files:[path]});}
  const upload=async(label:string,path:string)=>{await evaluate(`(()=>{const e=[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith(${JSON.stringify(label)})).querySelector('input');e.dataset.proof='upload';})()`);await file("upload",path);};
  await cdp("Page.enable");await cdp("Runtime.enable");await cdp("Log.enable");await cdp("WebAuthn.enable");
  if(process.env.HAIL_WIZARD_MOBILE==="true")await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:3,mobile:true});
  else await cdp("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await cdp("WebAuthn.addVirtualAuthenticator",{options:{protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await cdp("Browser.setDownloadBehavior",{behavior:"allow",downloadPath:work});
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("A little more signal."),"signed-out feed");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Signed-out feed overflows viewport");
  assert.equal(await evaluate(`!!document.querySelector('nav[aria-label="Main navigation"]') || !!document.querySelector('a[href="/compose"]')`),false,"Public home must not show private folders or compose");
  const privatePaths=["/permissions","/settings/security","/sent?after=older","/compose",`/sent/${incomingId}`,`/message/${encodeURIComponent(peerDid)}/${incomingId}`];
  for(const path of privatePaths){
    const response=await fetch(origin+path,{redirect:"manual"});assert.equal(response.status,303);
    assert.equal(new URL(response.headers.get("location")!,origin).searchParams.get("next"),path);
    assert.equal(response.headers.get("cache-control"),"no-store");
    const dataUrl=new URL(origin+path);dataUrl.pathname+="/__data.json";
    const routeData=await (await fetch(dataUrl)).json();assert.equal(routeData.type,"redirect");
    assert.equal(new URL(routeData.location,origin).searchParams.get("next"),path,"Client-side loads must use the same login destination");
    await cdp("Page.navigate",{url:origin+path});
    await wait(async()=>evaluate(`location.pathname==='/auth/login' && new URL(location.href).searchParams.get('next')===${JSON.stringify(path)}`),"anonymous screen uses shared login: "+path);
    assert(await has("Sign in to Haili"));
  }
  assert(!requests.some(r=>r.path==="/api/v1/account"),"Anonymous screens must not request account data");
  await cdp("Page.navigate",{url:origin+"/auth/login"});await wait(()=>has("Sign in to Hail"),"passkey login screen");
  assert.equal(await evaluate("document.querySelector('nav[aria-label=\"Main navigation\"]')===null"),true,"Login keeps a focused shell");
  await cdp("Page.navigate",{url:origin+"/auth/recover#token=hailp_"+"C".repeat(43)});
  await wait(async()=>evaluate(`location.hash==='' && document.querySelector('button')?.disabled===false`),"owner-authorized enrollment consumes its fragment locally");
  assert(await has("does not import a recovery backup"));
  assert(!requests.some(r=>r.path.includes("/recovery")),"Opening an enrollment link must not create a passkey");
  await cdp("Page.navigate",{url:origin+"/auth/authorize"});await wait(()=>has("This authorization request is invalid or incomplete"),"incomplete CLI authorization is refused");
  assert(!requests.some(r=>r.path.includes("/authorization/")),"Incomplete CLI authorization must not contact its API");
  const recoveryPreview=await fetch(origin+"/signup/recovery");
  assert(recoveryPreview.headers.get("content-security-policy")?.includes("connect-src 'none'; form-action 'none'"));
  await cdp("Page.navigate",{url:origin+"/signup/recovery"});await wait(()=>has("Recovery setup preview"),"local recovery preview presentation");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Recovery preview overflows viewport");
  await cdp("Page.navigate",{url:origin+"/signup#invitation="+invitation});
  await wait(()=>has("Start with an invitation"),"signup render");
  await wait(async()=>evaluate(`location.hash==='' && document.querySelector('input[maxlength="2048"]')?.value==='fixture-invitation'`) ,"signup hydration");
  assert.equal(await evaluate(`document.querySelector('[aria-label="Signup steps"] [aria-current=step]').textContent.trim()`),"1Invitation");
  assert.deepEqual(await styles("body",["backgroundColor","margin"]),["rgb(247, 248, 245)","0px"]);
  assert.equal(await evaluate("document.querySelector('nav[aria-label=\"Main navigation\"]')===null"),true,"Signup keeps a focused shell");
  assert.deepEqual(await styles("main > section",["display","gap","paddingTop","borderRadius"]),
    ["flex","20px",process.env.HAIL_WIZARD_MOBILE==="true"?"18px":"28px","18px"]);
  assert.deepEqual(await styles("input[type=password]",["borderTopWidth","borderTopStyle","borderRadius"]),["1px","solid","6px"]);
  await fill("Your Hail address","alice");await fill("External security-alert email","alice@example.net");
  await evaluate(`document.querySelector('input[type=checkbox]').click()`);
  await click("Create recovery kit locally");await wait(()=>has("Save and verify recovery"),"local key generation");
  assert.equal(await evaluate(`document.querySelector('[aria-label="Signup steps"] [aria-current=step]').textContent.trim()`),"2Recovery kit");
  secret=await evaluate("document.querySelector('[data-recovery-secret]').textContent");assert.equal(secret.length,43);
  assert.deepEqual(await styles("[data-recovery-secret]",["userSelect","overflowWrap"]),["all","anywhere"]);
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
  await evaluate(`[...document.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Continue an interrupted setup').open=true`);
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
  assert.equal(await evaluate(`document.querySelector('[aria-label="Signup steps"] [aria-current=step]').textContent.trim()`),"4Ready");
  assert(retired&&authenticated&&enrolled);assert.equal(prepareCalls,1);assert.equal(publicationAttempts,2);
  assert.equal(await evaluate("localStorage.getItem('hail.pending-signup.v1')"),null);
  await wait(async()=> (await readdir(work)).includes("hail-account-recovery.vault.json"),"final identity-bound backup");
  const finalBackup=JSON.parse(await readFile(join(work,"hail-account-recovery.vault.json"),"utf8"));assert(/^did:plc:[a-z2-7]{24}$/.test(finalBackup.did));
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Open your inbox').click()`);
  await wait(()=>has("No messages yet"),"completed alpha account inbox");
  assert(await has("alice@provider.example.com"));
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current=page]').textContent.trim()`),"Feed");
  assert.equal(await evaluate("document.querySelector('details').open"),false,"Technical account details start collapsed");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Empty feed overflows viewport");
  assert.deepEqual(await styles(".sidebar",["position"]),[process.env.HAIL_WIZARD_MOBILE==="true"?"static":"fixed"]);
  if(process.env.HAIL_WIZARD_MOBILE!=="true")assert(await evaluate("document.querySelector('.sidebar').getBoundingClientRect().right<=document.querySelector('main').getBoundingClientRect().left"),"Desktop sidebar overlaps content");
  else assert(await evaluate(`Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] a')).every(a=>a.getBoundingClientRect().right<=innerWidth && a.getBoundingClientRect().height>=44)`),"Mobile navigation must remain visible and touch-sized");
  await evaluate("document.querySelector('.skip-link').focus()");
  await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13});
  await wait(async()=>evaluate("document.activeElement?.id==='main-content'"),"keyboard skip to content");
  // Follow the same-document route out of sensitive signup into a message.
  // A full Page.navigate here would conceal a leaked signup form-action CSP.
  incoming=true;
  const messagePath=`/message/${encodeURIComponent(peerDid)}/${incomingId}`;
  await evaluate(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(messagePath)};a.textContent='Open received test';document.body.append(a);a.click();})()`);
  await wait(()=>has("Send reply"),"incoming one-time reply after signup navigation");
  assert.deepEqual(await styles("article",["borderRadius","overflow"]),["18px","hidden"]);
  assert.deepEqual(await styles("article > div",["fontSize","lineHeight"]),["18px","30.6px"]);
  await evaluate(`(()=>{const e=document.querySelector('textarea[name=text]');e.value='Browser transport reply';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click("Send reply");
  await wait(async()=>evaluate("location.pathname.startsWith('/sent/') && !!document.querySelector('[aria-label=\"Status: delivered\"]')"),"native reply form through provider proxy and redirect to Sent");
  assert.equal(replyPosts,1);
  await cdp("Page.navigate",{url:origin+messagePath});await wait(()=>has("This reply invitation has expired or was already used"),"consumed one-time reply");
  assert.equal(replyPosts,1);
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("Message feed"),"return to inbox");
  const feedImage='[aria-label="Messages"] img[alt="Bundled test header"]';
  await wait(async()=>evaluate(`document.querySelector('[aria-label="Inbox preferences"] input')?.disabled===false`),"feed preferences ready");
  assert(await evaluate(`document.querySelector(${JSON.stringify(feedImage)}).src.startsWith('data:image/png;base64,')`),"Feed header remains bundled");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Populated feed overflows viewport");
  await evaluate(`document.querySelector('[aria-label="Inbox preferences"] input').click()`);
  await wait(async()=>evaluate(`document.querySelector(${JSON.stringify(feedImage)})===null`),"hide feed headers");
  await evaluate("document.documentElement.dataset.beforePreferenceReload='true'");
  await cdp("Page.reload");await wait(async()=>evaluate(`!document.documentElement.dataset.beforePreferenceReload && document.querySelector('[aria-label="Inbox preferences"] input')?.disabled===false && document.querySelector('[aria-label="Inbox preferences"] input')?.checked===false && !document.querySelector(${JSON.stringify(feedImage)})`),"persist hidden header preference");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(feedImage)})===null`),true);
  await evaluate(`document.querySelector('[aria-label="Feed pages"] a').click()`);
  await wait(async()=>evaluate("new URL(location.href).searchParams.get('after')==='older-page' && !!document.querySelector('[aria-label=\"Feed pages\"] a[href=\"/\"]')"),"older feed page");
  await evaluate(`document.querySelector('[aria-label="Feed pages"] a[href="/"]').click()`);
  await wait(async()=>evaluate("location.search==='' && !!document.querySelector('[aria-label=\"Feed pages\"] a[href*=after]')"),"newest feed page");
  await evaluate(`document.querySelector('[aria-label="Inbox preferences"] input').click()`);
  await wait(async()=>evaluate(`!!document.querySelector(${JSON.stringify(feedImage)})`),"show feed headers again");
  const blockedStorage=await cdp("Page.addScriptToEvaluateOnNewDocument",{source:`Storage.prototype.getItem=Storage.prototype.setItem=()=>{throw new DOMException('Storage blocked','SecurityError');};`});
  await evaluate("document.documentElement.dataset.beforeStorageReload='true'");
  await cdp("Page.reload");await wait(async()=>evaluate(`!document.documentElement.dataset.beforeStorageReload && document.querySelector('[aria-label="Inbox preferences"] input')?.disabled===false && !!document.querySelector(${JSON.stringify(feedImage)})`),"feed remains readable when storage is blocked");
  await evaluate(`document.querySelector('[aria-label="Inbox preferences"] input').click()`);
  await wait(async()=>evaluate(`!document.querySelector(${JSON.stringify(feedImage)})`),"header toggle works without storage");
  await cdp("Page.removeScriptToEvaluateOnNewDocument",{identifier:blockedStorage.identifier});
  // A new document restores ordinary storage before the permission ceremony.
  await cdp("Page.navigate",{url:origin+"/"});await wait(async()=>evaluate(`document.querySelector('[aria-label="Inbox preferences"] input')?.disabled===false && !!document.querySelector(${JSON.stringify(feedImage)})`),"restore normal feed preferences");
  await evaluate(`[...document.querySelectorAll('nav a')].find(a=>a.textContent.trim()==='Allowed senders').click()`);
  await wait(()=>has("No permissions on this page"),"allowed-sender list");
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current=page]').textContent.trim()`),"Allowed senders");
  await fill("Potential sender's Hail address",peerAddress);await click("Review sender");await wait(()=>has("Test sender"),"verified sender review");
  await evaluate(`document.querySelector('fieldset input[value=updates]').click()`);
  assert.deepEqual(await styles("fieldset label",["flexDirection","alignItems"]),["row","center"]);
  await click("Review permission before approving");await wait(()=>has("Confirm allowed sender"),"exact permission review");
  assert.deepEqual(await styles('[aria-label="Permission confirmation"]',["borderTopWidth","borderTopColor"]),["2px","rgb(15, 118, 110)"]);
  assert.equal(allowed,null);assert(await has("alice@provider.example.com"));
  await click("Allow sender with my passkey");await wait(()=>has("Review revocation"),"passkey-approved permission saved");
  assert.equal(allowed!.status,"active");await click("Review revocation");await wait(()=>has("Confirm revocation"),"revocation review");
  await click("Revoke sender with my passkey");await wait(()=>has("revoked"),"passkey-confirmed revocation");
  assert.equal(allowed!.status,"revoked");
  await click("Show my sender QR");assert(await evaluate("!!document.querySelector('svg[role=img] path')"));
  const qrRequests=requests.filter(r=>r.path.endsWith("/permissions/prepare")).length;
  await cdp("Page.navigate",{url:origin+"/permissions#"+new URLSearchParams({sender:peerAddress,did:peerDid})});
  await wait(()=>has("QR identity pin:"),"scanned sender QR prefill");
  assert.equal(await evaluate(`document.querySelector('input[placeholder="sender@business.example"]').value`),peerAddress);
  assert.equal(requests.filter(r=>r.path.endsWith("/permissions/prepare")).length,qrRequests,"Opening a QR must not prepare or approve a permission");
  await click("Review sender");await wait(()=>has("Test sender"),"QR and typed address share the same review");
  await cdp("Page.navigate",{url:origin+"/compose"});await wait(()=>has("Publish an update"),"publisher styling");
  assert.deepEqual(await styles("form[enctype] label",["display","fontWeight"]),["grid","600"]);
  assert.deepEqual(await styles("fieldset label",["display","gap"]),["flex","8px"]);
  assert.deepEqual(await styles("fieldset input",["width"]),["13px"]);
  assert.deepEqual(await styles('[aria-label="Bold"]',["backgroundColor","paddingTop","borderTopWidth"]),["rgb(255, 255, 255)","10px","1px"]);
  assert.deepEqual(await styles('[aria-label="Message preview"]',["minHeight"]),[process.env.HAIL_WIZARD_MOBILE==="true"?"260px":"360px"]);
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Composer overflows viewport");
  await evaluate(`(()=>{const e=document.querySelector('textarea[name=text]');e.value='A clear message';e.dispatchEvent(new Event('input',{bubbles:true}));e.setSelectionRange(2,7);})()`);
  await evaluate(`document.querySelector('[aria-label="Bold"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('[aria-label="Message preview"] span[class*="font-[750]"]')?.textContent==='clear'`),"formatting stays visible in preview");
  for(const [button,selector] of [["Heading","h2"],["Quote","blockquote"],["Bullets","ul li"],["Numbered list","ol li"]]){
    await click(button);await wait(async()=>evaluate(`document.querySelector('[aria-label="Message preview"] ${selector}')?.textContent==='A clear message'`),"block toolbar: "+button);
  }
  await evaluate(`document.querySelector('input[type=radio][value=plain]').click()`);
  await wait(async()=>evaluate(`document.querySelector('input[name=title]').disabled && !document.querySelector('[aria-label="Text formatting"]') && !document.querySelector('[aria-label="Block formatting"]')`),"plain format disables rich-only controls");
  // Publish a local-fixture incoming Grant, then submit the real native composer form.
  const payload:HailGrant={...permissionPayload(sendingGrantId),grantor:peerDid,grantee:did!,key_id:peerDid+"#hail-identity",
    consent_context:{...permissionPayload(sendingGrantId).consent_context,grantee_address:prepared.address}};
  const signed=await signPayload("hail.grant",payload,createWebCryptoSigner(peerDid+"#hail-identity",permissionSigner.privateKey));
  sendingGrant={payload,cose:encodeBase64Url(signed),digest:encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(signed))))};
  await cdp("Page.navigate",{url:origin+"/compose?rich-proof=1"});
  await wait(async()=>evaluate(`document.querySelector('select[name=category]')?.options.length===3`),"category audiences are available");
  assert.equal(await evaluate(`document.querySelector('select[name=category]').value`),"general","General is the default category");
  assert(await evaluate(`!document.querySelector('select[name=target]') && !document.querySelector('input[name=grantId]')`),"Publisher must not select individual subscription recipients");
  const richText="## Highlights\n- **First**\n- Second\n1. Number one\n2. Number two\n> A quote\n\n<img src=x onerror=alert(1)>";
  await fill("Title","Release notes");
  await evaluate(`(()=>{const e=document.querySelector('textarea[name=text]');e.value=${JSON.stringify(richText)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(async()=>evaluate(`document.querySelector('[aria-label="Message preview"] h1')?.textContent==='Release notes' && document.querySelectorAll('[aria-label="Message preview"] ul li').length===2 && document.querySelectorAll('[aria-label="Message preview"] ol li').length===2`),"rich message preview");
  const rendered=async(selector:string)=>evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return {headings:[...e.querySelectorAll('h1,h2,h3')].map(n=>n.textContent),bullets:[...e.querySelectorAll('ul li')].map(n=>n.textContent),numbered:[...e.querySelectorAll('ol li')].map(n=>n.textContent),quote:e.querySelector('blockquote')?.textContent,images:e.querySelectorAll('img').length,text:e.innerText.includes('<img src=x onerror=alert(1)>')};})()`);
  const previewContent=await rendered('[aria-label="Message preview"]');
  assert.deepEqual(previewContent,{headings:["Release notes","Highlights"],bullets:["First","Second"],numbered:["Number one","Number two"],quote:"A quote",images:0,text:true});
  await evaluate(`document.querySelector('form[enctype]').requestSubmit()`);
  await wait(()=>has("Publication publishing"),"durable category publication accepted");assert.equal(composePosts,1);
  assert(await has("2 subscribers in the saved audience"));
  await click("Refresh status");await wait(()=>has("Publication finished"),"publication work is distinct from delivery status");
  assert(await has("1 delivered"));assert(await has("1 indeterminate"));
  await evaluate(`document.querySelector('[aria-label="Publication status"] a[href="/sent"]').click()`);
  await wait(()=>has("Sent messages"),"publication links to per-message delivery details");
  await evaluate(`document.querySelector(${JSON.stringify(`a[href="/sent/${composed.messageId}"]`)}).click()`);
  await wait(async()=>evaluate(`location.pathname===${JSON.stringify(`/sent/${composed.messageId}`)} && !!document.querySelector('article h1')`),"sent rich-message reader");
  assert.deepEqual(await rendered('article > div'),previewContent,"Preview and sent reader must render the same safe content");
  // Expired sessions use the same login, preserve the QR fragment, and clear the stale cookie.
  const qrFragment=new URLSearchParams({sender:peerAddress,did:peerDid}).toString();
  await cdp("Network.setCookie",{name:"hail_session",value:"hails_"+"B".repeat(43),url:origin,httpOnly:true,sameSite:"Lax"});
  await cdp("Page.navigate",{url:origin+"/permissions#"+qrFragment});
  await wait(async()=>evaluate(`location.pathname==='/auth/login' && new URL(location.href).searchParams.get('next')==='/permissions' && location.hash===${JSON.stringify("#"+qrFragment)}`),"expired-session login preserves QR identity pin");
  const cookies=await cdp("Network.getCookies",{urls:[origin]});assert(!cookies.cookies.some((cookie:any)=>cookie.name==="hail_session"),"Expired cookie must be cleared");
  await click("Sign in with a passkey");await wait(()=>has("QR identity pin:"),"shared passkey login returns to QR review");
  assert.equal(await evaluate(`document.querySelector('input[placeholder="sender@business.example"]').value`),peerAddress);
  assert.equal(requests.filter(r=>r.path.endsWith("/permissions/prepare")).length,qrRequests,"Signing in through a QR must not approve or prepare it");
  // Verify each ordinary folder resumes after login, including its query string.
  for(const [path,text] of [["/sent?after=older","Sent messages"],["/compose","Publish an update"],["/settings/security","Passkeys & security"]]){
    await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
    await cdp("Page.navigate",{url:origin+path});
    await wait(async()=>evaluate(`location.pathname==='/auth/login' && new URL(location.href).searchParams.get('next')===${JSON.stringify(path)}`),"folder login: "+path);
    await click("Sign in with a passkey");
    await wait(async()=>evaluate(`location.pathname+location.search===${JSON.stringify(path)} && document.body.innerText.includes(${JSON.stringify(text)})`),"resume folder: "+path);
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),path+" overflows viewport");
  }
  assert(await has("Recovery is separate"));
  assert(await evaluate(`document.querySelectorAll('button').length>0 && [...document.querySelectorAll('button')].find(b=>b.textContent==='Revoke').disabled`),"Current/last passkey cannot be revoked");
  recentlyVerified=false;
  await cdp("Page.navigate",{url:origin+"/settings/security?fresh=1"});await wait(()=>has("Verify with your current passkey before adding"),"security management requires fresh verification");
  assert(await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Add passkey').disabled`));
  await click("Verify to manage");await wait(async()=>evaluate(`location.search==='?fresh=1' && [...document.querySelectorAll('button')].find(b=>b.textContent==='Add passkey')?.disabled===false`),"fresh passkey verification unlocks management");
  generalAvailable=true;
  await cdp("Page.navigate",{url:origin+"/permissions?general-proof=1"});await wait(()=>has("Potential sender's Hail address"),"General subscription screen");
  await fill("Potential sender's Hail address",peerAddress);await click("Review sender");
  await wait(async()=>evaluate(`!!document.querySelector('input[value=general]')`),"General is an ordinary offered category");
  assert(!await has("Allow uncategorized messages instead"));
  await evaluate(`document.querySelector('input[value=general]').click()`);
  await click("Review permission before approving");await wait(()=>has("Confirm allowed sender"),"review General subscription");
  assert(await has("Scope: General"));await click("Allow sender with my passkey");
  await wait(async()=>evaluate(`[...document.querySelectorAll('[aria-label="Issued permissions"] article p')].some(p=>p.textContent.startsWith('General · active'))`),"new General subscription saved");
  assert.equal(allowed!.revision,1);assert.deepEqual(allowed!.scope,[{type:"categories",values:["general"]}]);
  // Separate permanent/expiring codes and real browser passkey confirmation (API fixtures).
  await cdp("Page.navigate",{url:origin+"/settings/security?connections=1"});await wait(()=>has("Create my personal code"),"personal connection code creation");
  await click("Create my personal code");await wait(()=>has("Confirm new connection code"),"standing invitation consent");
  assert(await has("without another approval from you"));assert(await has("No automatic expiry"));
  await click("Confirm with passkey");await wait(()=>has("Show my QR & link"),"personal code saved");
  await click("Show my QR & link");await wait(async()=>evaluate(`!!document.querySelector('svg[aria-label="Connection QR code"]')`),"local QR rendering");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Connection QR overflows viewport");
  await click("Hide code");await fill("Private label","Conference");
  await fill("Expires (your local time)","2027-01-15T18:00");await click("Review new link");await wait(()=>has("Confirm new connection code"),"expiring code review");
  await click("Confirm with passkey");await wait(async()=>connectionCodes.length===2&&await has("Saved. Existing subscriptions are unchanged."),"expiring code saved");
  assert.equal(connectionCodes.length,2);assert.equal(connectionCodes.filter(code=>code.personal).length,1);
  assert(connectionCodes.find(code=>!code.personal)!.expiresAt!>0);assert.equal(connectionCodes.find(code=>code.personal)!.expiresAt,null);
  await click("Replace personal code");await wait(()=>has("Confirm personal code replacement"),"personal replacement review");
  await click("Confirm with passkey");await wait(()=>has("Saved. Existing subscriptions are unchanged."),"replacement committed");
  assert.equal(connectionCodes.length,2);
  await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
  const invitationLink=origin+"/connect#"+new URLSearchParams({id:fixtureInvitationId,did:peerDid,token:fixtureAdmissionToken});
  await cdp("Page.navigate",{url:invitationLink});await wait(()=>has("Sign in to review"),"signed-out scanner consent");
  await wait(async()=>evaluate("location.hash===''"),"admission token removed from URL");
  await evaluate(`document.querySelector('a[href="/auth/login?next=%2Fconnect"]').click()`);await wait(()=>has("Sign in to Haili"),"scanner login");
  assert.equal(await evaluate("new URL(location.href).searchParams.get('next')"),"/connect");
  await click("Sign in with a passkey");await wait(()=>has("Review connection code"),"scanner returns without token in login URL");
  await click("Review connection code");await wait(()=>has("Review before connecting"),"identity pinned scanner review");
  assert(await has(peerDid));assert(!personalConnection);
  await click("Review before connecting");await wait(()=>has("Confirm connection"),"exact connection consent");
  assert(!personalConnection);await click("Confirm with passkey");await wait(()=>has("Connection saved"),"mutual connection confirmed");
  await cdp("Page.navigate",{url:origin+"/settings/security?connected=1"});await wait(()=>has("Disconnect"),"connected account visible");
  await click("Disconnect");await wait(()=>has("Confirm disconnect"),"disconnect review");await click("Confirm with passkey");await wait(()=>has("No connections yet."),"disconnect saved");
  assert(!personalConnection);assert.equal(allowed!.status,"active");
  const savedConnectionReview=[...connectionApprovals.values()].find(row=>row.action==="connect")!;
  await evaluate(`sessionStorage.setItem('hail.connection-approval.v1',${JSON.stringify(savedConnectionReview.requestId)})`);
  await cdp("Page.navigate",{url:origin+"/connect"});await wait(()=>has("Continue interrupted review"),"old approval status after disconnect");
  await click("Continue interrupted review");await wait(()=>has("It was not reopened."),"historical success does not masquerade as a live connection");assert(!personalConnection);
  assert.equal(composePosts,1);assert.equal(replyPosts,1);
  for(const req of requests){assert(!req.body.includes(secret),"Recovery secret uploaded");assert(!req.body.includes('"ciphertext"'),"Recovery vault uploaded");}
  assert(requests.filter(r=>r.authorization).every(r=>r.authorization==="Bearer "+setupToken||r.path.endsWith("check-address")));
  passed=true;
  console.info("PASS: Chromium public/private shells, sign-in return paths and QR pins, signup, messaging, permissions and security (local API fixtures only)");
}finally{
  socket?.close();chrome?.kill();gui?.kill();server.stop(true);
  if(chrome)await chrome.exited;if(gui)await gui.exited;
  if(!passed&&gui)console.error((await new Response(gui.stderr).text()).slice(-2000));
  if(!passed)console.error(browserErrors.slice(-5).join("\n"));
  provider.recoverySecret.fill(0);messaging.recoverySecret.fill(0);secret="";
  await rm(work,{recursive:true,force:true});
}
