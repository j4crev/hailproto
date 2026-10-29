// Built GUI + Chromium + virtual WebAuthn; local API fixtures, no public writes or mail.
import {strict as assert} from "node:assert";
import {mkdir,mkdtemp,readFile,readdir,writeFile,rm} from "node:fs/promises";
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
let passed=false,logoutAttempts=0;
let ownProfile:any=null,profileWrites=0,profileVerificationMismatch=false;
let recoveryVerified=false,emailVerified=false,verifiedDigest="";
let prepared:any=null,state="recovery-required",operation:any=null,enrolled=false,retired=false,authenticated=false,challenge="",credential:any;
let did:string|null=null;const sessionToken="hails_"+"A".repeat(43);
let setupId="",setupToken="",enrollmentToken="",secret="",invitation="fixture-invitation",publicationAttempts=0,prepareCalls=0;
const browserErrors:string[]=[];
const requests:{path:string;body:string;authorization:string}[]=[];
const policy={provider:"https://provider.example.com",monitorOrigin:"https://monitor.example",monitorKey:messaging.vault.identity.publicDidKey};
const permissionSigner=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]),peerDid="did:plc:"+"b".repeat(24),peerAddress="peer@peer.example.com";
let allowed:HailGrant|null=null,allowedCose="",allowedDigest="",generalAvailable=false;
const approvals=new Map<string,{action:string;payload:HailGrant;challenge:string;approved:boolean;result:unknown}>();
const connectionCodes:{id:string;personal:boolean;label:string;expiresAt:number|null;link:string}[]=[],connectionApprovals=new Map<string,any>();
let connectionCommitLost=false,connectionStatusUnavailable=false;
let personalConnection=false,ownerConnectionSigning=false,federatedConnecting=false,federationPolls=0;
const fixtureConnectionId=uuidV7(),fixtureInvitationId=uuidV7(),fixtureAdmissionToken="K".repeat(43);
const incomingId="019a15fd-2bd0-7433-8afa-bd0355e0608d";
const sendingGrantId="019a15fd-2bd0-7433-8afa-bd0355e0608e";
let sendingGrant:{payload:HailGrant;cose:string;digest:string}|null=null,composed:any=null,composePosts=0;
let publicationIntent:any=null,publicationReads=0,publicationCreated=0,composedOther:any=null;
let connectionMessageIntent:any=null,connectionMessageReads=0,connectionIncoming=false,loseConnectionAcceptance=true;
const connectionSent:any[]=[],otherConnectionId=uuidV7(),connectionIncomingId=uuidV7();
const otherConnectionDid='did:plc:'+'c'.repeat(24);
const connectionMessageResult=()=>({publicationId:connectionMessageIntent.publicationId,kind:'connections',category:null,total:connectionSent.length,
  state:connectionMessageReads>=2?'finished':'publishing',counts:{pending:connectionMessageReads>=2?0:connectionSent.length,submitted:connectionMessageReads>=2?connectionSent.length:0,blocked:0,cancelled:0,expired:0,indeterminate:0},
  delivery:{accepted:0,delivered:connectionMessageReads>=2?connectionSent.length:0,'on-hold':0,failed:0,cancelled:0,indeterminate:0},
  targets:connectionSent.map(message=>({messageId:message.messageId,recipient:message.recipient,state:connectionMessageReads>=2?'submitted':'pending',delivery:connectionMessageReads>=2?'delivered':null})),
  createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()});
const publicationResult=()=>({publicationId:publicationIntent.publicationId,category:publicationIntent.category,total:2,state:publicationReads>=2?"finished":"publishing",
  counts:{pending:publicationReads>=2?0:2,submitted:publicationReads>=2?2:0,blocked:0,cancelled:0,expired:0,indeterminate:0},
  delivery:{accepted:0,delivered:publicationReads>=2?1:0,"on-hold":0,failed:0,cancelled:0,indeterminate:publicationReads>=2?1:0},
  targets:[composed,composedOther].map(message=>({messageId:message.messageId,recipient:message.recipient,state:publicationReads>=2?"submitted":"pending",delivery:publicationReads>=2?message.state:null})),
  createdAt:new Date(publicationCreated).toISOString(),expiresAt:new Date(publicationCreated+86400000).toISOString()});
let trashEnabled=true;const trashed=new Map<string,string>(),deleted=new Set<string>();
let incoming=false,replyPosts=0,replied:any=null,recentlyVerified=false,guiProxy:ReturnType<typeof createApp>;
const textBody=(text:string)=>({version:1,profile:"spt-1",blocks:[{_type:"block",_key:"b1",style:"normal",markDefs:[],children:[{_type:"span",_key:"s1",text,marks:[]}]}]});
const connectionReply=()=>({messageId:connectionIncomingId,sender:peerDid,senderAddress:peerAddress,recipient:did,category:null,kind:'connection',
  deliveredAt:new Date().toISOString(),body:textBody('A personal connection reply'),reply:{allowed:false},replyAvailable:false,connection:{id:fixtureConnectionId,epoch:1,active:personalConnection}});
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
let signupMode:"invite"|"public"="invite";
const server=Bun.serve({hostname:"::",port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  assert(!request.url.includes(fixtureAdmissionToken),"Connection token leaked into an HTTP URL");
  assert(!request.headers.get("Referer")?.includes(fixtureAdmissionToken),"Connection token leaked into referrer");
  if(!path.startsWith("/api/")){
    try{return await guiProxy.fetch(request);}
    catch{return new Response("GUI starting",{status:503});}
  }
  const body=await request.text();requests.push({path,body,authorization:request.headers.get("Authorization")??""});const input=body?JSON.parse(body):{};
  if(path==='/api/v1/account/connection-messages/targets')return json({maxRecipients:100,connections:personalConnection?[
    {connectionId:fixtureConnectionId,recipientDid:peerDid,epoch:1,address:peerAddress},{connectionId:otherConnectionId,recipientDid:otherConnectionDid,epoch:1,address:'other@peer.example.com'}]:[]});
  if(path==='/api/v1/account/connection-messages'){
    if(request.method==='GET')return json({publications:connectionMessageIntent?[{publicationId:connectionMessageIntent.publicationId,category:null,createdAt:new Date().toISOString(),pending:connectionMessageReads<2}]:[]});
    assert(personalConnection);assert.deepEqual(Object.keys(input).sort(),['connections','publicationId','text']);
    assert.deepEqual([...input.connections].sort(),[fixtureConnectionId,otherConnectionId].sort());
    if(connectionMessageIntent){assert.deepEqual(input,connectionMessageIntent);return json(connectionMessageResult(),202);}
    connectionMessageIntent=input;
    for(const [recipient,address] of [[peerDid,peerAddress],[otherConnectionDid,'other@peer.example.com']])connectionSent.push({messageId:uuidV7(),sender:did,recipient,recipientAddress:address,
      category:null,kind:'connection',createdAt:new Date().toISOString(),state:'delivered',revision:2,reason:null,retryAt:null,body:textBody(input.text)});
    if(loseConnectionAcceptance){loseConnectionAcceptance=false;return json({error:'Simulated lost acceptance response'},503);}
    return json(connectionMessageResult(),202);
  }
  if(connectionMessageIntent&&path===`/api/v1/account/connection-messages/${connectionMessageIntent.publicationId}`){connectionMessageReads++;return json(connectionMessageResult());}
  if(path==='/api/v1/account/message-preferences'){
    if(request.method==='POST'){trashEnabled=input.trashEnabled;if(!trashEnabled){for(const id of trashed.keys())deleted.add(id);trashed.clear();}}
    return json({trashEnabled});
  }
  if(path.endsWith('/delete')&&path.startsWith('/api/v1/account/inbox/')){
    const id=path.split('/').at(-2)!;if(trashEnabled)trashed.set(id,new Date().toISOString());else deleted.add(id);
    return json({state:trashEnabled?'trashed':'deleted'});
  }
  if(path==='/api/v1/account/trash')return json({messages:[incomingMessage(),connectionReply()].filter(m=>trashed.has(m.messageId)).map(m=>({...m,trashedAt:trashed.get(m.messageId)})),next:null});
  if(path==='/api/v1/account/trash/restore'){let restored=0;for(const m of input.messages)if(trashed.delete(m.messageId))restored++;return json({restored});}
  if(connectionIncoming&&(path===`/api/v1/account/inbox/${encodeURIComponent(peerDid)}/${connectionIncomingId}`||path===`/api/v1/account/inbox/${peerDid}/${connectionIncomingId}`))return json(connectionReply());
  if(path.startsWith("/api/v1/account/connections")){
    assert(request.headers.get("Cookie")?.includes("hail_session="+sessionToken));
    const step=path.split("/")[5];
    const advanceFederation=()=>{if(federatedConnecting&&[...connectionApprovals.values()].some(row=>row.result?.state==='connecting')&&++federationPolls>=6){personalConnection=true;for(const row of connectionApprovals.values())if(row.result?.state==='connecting')row.result={connectionId:fixtureConnectionId,attemptId:row.requestId,state:'active'};}};
    if(!step){advanceFederation();return json({preview:true,codes:connectionCodes,connections:personalConnection?[{id:fixtureConnectionId,did:peerDid,address:peerAddress,connectedAt:new Date().toISOString(),remote:federatedConnecting}]:[],
      pendingConnections:federatedConnecting&&!personalConnection&&[...connectionApprovals.values()].some(row=>row.result?.state==='connecting')?[{id:fixtureConnectionId,did:peerDid,address:peerAddress,kind:'connect',state:'pending'}]:[]});}
    if(step==="review"){assert.equal(input.id,fixtureInvitationId);assert.equal(input.did,peerDid);assert.equal(input.token,fixtureAdmissionToken);
      return json({id:input.id,did:peerDid,address:peerAddress,expiresAt:null,preview:true});}
    if(step==="prepare"){
      const options=await generateAuthenticationOptions({rpID:"localhost",userVerification:"required",allowCredentials:[{id:credential.id}]});
      const review={...input,...(input.action==="connect"?{address:peerAddress}:{})};delete review.token;
      const row={requestId:input.requestId,action:input.action,review,expiresAt:new Date(Date.now()+300000).toISOString(),result:null,options};
      if(ownerConnectionSigning&&input.action==="create"){
        const tokenBytes=new Uint8Array(Buffer.from("M".repeat(43),"base64url"));
        const payload={type:"hail.connection-invitation" as const,version:1 as const,invitation_id:uuidV7(),from:did!,
          token_hash:{algorithm:"sha-256" as const,value:new Uint8Array(await crypto.subtle.digest("SHA-256",tokenBytes))},issued_at:Math.floor(Date.now()/1000),expires_at:input.expiresAt,key_id:did!+"#hail-identity"};
        Object.assign(row,{ownerSigning:{type:"hailp.connection-signing",version:1,provider:origin,requestId:row.requestId,expiresAt:row.expiresAt,payload:toDiagnosticJson(payload.type,payload)}});
      }
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
        else{personalConnection=row.action==="connect"&&!federatedConnecting;row.result=row.action==="connect"&&federatedConnecting?{connectionId:null,attemptId:row.requestId,state:'connecting'}:{connectionId:fixtureConnectionId,state:personalConnection?"active":"disconnected"};}
        row.options=null;
      }
      if(connectionCommitLost){connectionCommitLost=false;connectionStatusUnavailable=true;return json({},503);}
      return json(row);
    }
    if(connectionStatusUnavailable){connectionStatusUnavailable=false;return json({},503);}
    if(connectionApprovals.get(step)?.result?.state==='connecting')advanceFederation();
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
  for(const message of [replied,composed,composedOther,...connectionSent])if(message&&path===`/api/v1/account/sent/${message.messageId}`)return json(message);
  if(path==="/api/v1/account/sent")return json({messages:[...connectionSent,composed,composedOther,replied].filter(Boolean),next:null});
  if(path==="/api/v1/auth/passkeys")return json({recentlyVerified,sessions:[],passkeys:[{credentialId:credential.id,label:"Primary passkey",deviceType:"multiDevice",backedUp:true,
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
  if(path==="/api/v1/account/grants")return json({grants:[...(allowed?[{grantId:allowed.grant_id,localRole:"grantor",grantee:allowed.grantee,status:allowed.status}]:[]),...(sendingGrant?[{grantId:sendingGrantId,localRole:"grantee",status:"active",expiresAt:sendingGrant.payload.expires_at}]:[])],next:null});
  if(path===`/api/v1/account/grants/${sendingGrantId}`&&sendingGrant)return json({type:"hailp.grant",version:1,cose:sendingGrant.cose,digest:sendingGrant.digest,localRole:"grantee"});
  if(path.startsWith("/api/v1/account/grants/")&&allowed)return json({type:"hailp.grant",version:1,cose:allowedCose,digest:allowedDigest,localRole:"grantor"});
  if(path==="/api/v1/account/profile"){
    if(!request.headers.get("Cookie")?.includes("hail_session="+sessionToken))return json({},401);
    if(request.method==="POST"){
      if(!recentlyVerified)return json({},403);
      if(input.expectedRevision!==(ownProfile?.revision??0))return json({},409);
      assert(input.definition.display_name);assert.equal(input.definition.offers_uncategorized,false);
      const payload={type:"hail.sender-profile",version:input.definition.version,did,revision:(ownProfile?.revision??0)+1,
        display_name:input.definition.display_name,...(input.definition.description?{description:input.definition.description}:{}),
        offers_uncategorized:input.definition.offers_uncategorized,categories:input.definition.categories,updated_at:Math.floor(Date.now()/1000),key_id:did+"#hail-messaging"};
      const cose=await signPayload("hail.sender-profile",payload,createWebCryptoSigner(payload.key_id,permissionSigner.privateKey));
      ownProfile={type:"hailp.sender-profile",version:1,revision:payload.revision,cose:encodeBase64Url(cose),
        digest:encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(cose)))),profile:toDiagnosticJson("hail.sender-profile",payload)};
      profileWrites++;
    }
    return ownProfile?json(ownProfile):json({},404);
  }
  if(path==="/api/v1/account"||path==="/api/v1/account/inbox"){
    if(!request.headers.get("Cookie")?.includes("hail_session="+sessionToken))return json({},401);
    assert(retired,"Inbox must use the completed account's session");
    const query=new URL(request.url).searchParams,personal=query.get('kind')==='connections';
    return json(path.endsWith("/inbox")?{messages:(personal?(connectionIncoming?[connectionReply()]:[]):incoming?[incomingMessage()]:[]).filter(m=>!trashed.has(m.messageId)&&!deleted.has(m.messageId)),next:!personal&&incoming&&!query.has("after")?"older-page":null}:{type:"hailp.account",version:1,provider:policy.provider,accountId:prepared.accountId,
      address:prepared.address,did:profileVerificationMismatch?peerDid:did,migrationState:null,custodyProfile:"managed",monitorVerificationMode:"reduced-assurance-alpha-v1",managedProfileVersion:"hail-managed-custody-v1",
      identityPublicKey:prepared.userIdentityKey,ownerRecoveryPublicKey:prepared.userRecoveryKey,scopes:["account:read","grants:read","messages:read","messages:write"]});
  }
  if(path==="/api/v1/registration")return json({mode:signupMode,signupAvailable:true});
  if(path.startsWith("/api/v1/operator/")){
    if(!authenticated)return json({},403);
    if(path.endsWith("/invitations"))return json({invitations:[]});
    if(path.endsWith("/stats"))return json({},503);
    if(path.endsWith("/registration")){
      if(request.method==="POST"){assert(["invite","public"].includes(input.mode));signupMode=input.mode;}
      return json({mode:signupMode});
    }
  }
  if(path==="/api/v1/signup/check-address")return json({address:input.address,available:true});
  if(path==="/api/v1/signup"){
    assert.equal(input.backupVerified,false);prepareCalls++;setupId=input.signupId;setupToken=request.headers.get("Authorization")!.slice(7);
    prepared={accountId:crypto.randomUUID(),address:input.address,userRecoveryKey:input.recoveryKey,userIdentityKey:provider.vault.identity.publicDidKey,
      providerRotationKey:provider.vault.recovery.publicDidKey,providerMessagingKey:messaging.vault.identity.publicDidKey,sourceServiceBase:policy.provider+"/hail",
      custodyProfile:"managed",managedProfileVersion:"hail-managed-custody-v1",monitorAssurance:"reduced-assurance-alpha-v1",monitorOrigin:policy.monitorOrigin,monitorPublicKey:policy.monitorKey};
    return json(summary());
  }
  if(path===`/api/v1/signup/${setupId}/verify-backup`){
    assert.equal(input.backupVerified,true);assert.equal(input.operation,undefined);assert.equal(input.operationDigest.length,43);verifiedDigest=input.operationDigest;
    recoveryVerified=true;state="prepared";return json(summary());
  }
  if(path===`/api/v1/signup/${setupId}`)return retired?json({},403):json(summary());
  if(path==="/api/v1/signup-email/start")return json({verified:emailVerified,expiresAt:Date.now()+600_000});
  if(path==="/api/v1/signup-email/verify"){assert.equal(input.code,"12345678");emailVerified=true;return json({verified:true,expiresAt:Date.now()+600_000});}
  if(path===`/api/v1/signup/${setupId}/advance`){
    assert(recoveryVerified&&emailVerified);publicationAttempts++;enrollmentToken=input.enrollmentToken;
    if(input.operation){await assureValidSig([prepared.userRecoveryKey],input.operation);if(operation)assert.deepEqual(input.operation,operation);operation=input.operation;}
    assert(operation,"Expected retained signed genesis");
    assert.equal(encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(operation))))),verifiedDigest);
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
  if(path==="/api/v1/auth/logout"){assert.equal(request.method,"POST");assert(request.headers.get("Cookie")?.includes(sessionToken));if(++logoutAttempts===1)return json({error:"Temporary logout failure"},503);authenticated=false;return json({ok:true});}
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
  const selectedAudience=async(label:string)=>{
    await evaluate('document.activeElement?.blur()');
    assert.equal(await evaluate(`document.querySelector('[aria-label="Compose audience"] [aria-current="page"]').textContent`),label);
    assert.deepEqual(await styles('[aria-label="Compose audience"] [aria-current="page"]',["backgroundColor","color"]),["rgb(15, 118, 110)","rgb(255, 255, 255)"]);
    assert.deepEqual(await styles('[aria-label="Compose audience"] a:not([aria-current])',["backgroundColor"]),["rgb(255, 255, 255)"]);
  };
  const screenshot=async(name:string)=>{if(!process.env.HAIL_WIZARD_SCREENSHOTS)return;await mkdir(process.env.HAIL_WIZARD_SCREENSHOTS,{recursive:true});const shot=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});await writeFile(join(process.env.HAIL_WIZARD_SCREENSHOTS,`${process.env.HAIL_WIZARD_MOBILE==='true'?'mobile':'desktop'}-${name}.png`),Buffer.from(shot.data,"base64"));};
  const escape=async()=>{await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});};
  const pointer=async(x:number,y:number)=>{await cdp("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,x,y});await cdp("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,x,y});};
  const openAccount=async()=>{await evaluate(`(()=>{const b=[...document.querySelectorAll('[aria-label="Open account menu"]')].find(b=>b.checkVisibility());b.focus();b.click();})()`);await wait(async()=>evaluate(`!!document.querySelector('[popover]:popover-open')`),"avatar opens account menu");};
  const accountNavigation=async()=>assert(await evaluate(`Array.from(document.querySelectorAll('a[href="/account"], a[href="/settings"], a[href="/settings/security"]')).every(a=>a.closest('nav[aria-label="Account menu"]'))`),"Account destinations belong only in the profile menu");
  const narrowLayouts=async()=>{
    if(process.env.HAIL_WIZARD_MOBILE!=="true")return;
    for(const width of [320,768,390]){
      await cdp("Emulation.setDeviceMetricsOverride",{width,height:844,deviceScaleFactor:3,mobile:true});
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),`Page overflows at ${width}px`);
    }
  };
  const noPrematureSignIn=async()=>assert(await evaluate(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Sign in and finish')`),"Sign-in offered before confirmed passkey enrollment");
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
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("Your permission."),"signed-out feed");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Signed-out feed overflows viewport");
  assert.equal(await evaluate(`!!document.querySelector('nav[aria-label="Main navigation"]') || !!document.querySelector('a[href="/compose"]')`),false,"Public home must not show private folders or compose");
  await narrowLayouts();await screenshot("home");
  const privatePaths=["/trash","/categories","/account","/settings","/connections","/permissions","/settings/security","/sent?after=older","/compose","/?view=connections",`/sent/${incomingId}`,`/message/${encodeURIComponent(peerDid)}/${incomingId}`];
  for(const path of privatePaths){
    const response=await fetch(origin+path,{redirect:"manual"});assert.equal(response.status,303);
    assert.equal(new URL(response.headers.get("location")!,origin).searchParams.get("next"),path);
    assert.equal(response.headers.get("cache-control"),"no-store");
    const dataUrl=new URL(origin+path);dataUrl.pathname=dataUrl.pathname.replace(/\/$/,"")+"/__data.json";
    const routeData=await (await fetch(dataUrl)).json();assert.equal(routeData.type,"redirect");
    assert.equal(new URL(routeData.location,origin).searchParams.get("next"),path,"Client-side loads must use the same login destination");
    await cdp("Page.navigate",{url:origin+path});
    await wait(async()=>evaluate(`location.pathname==='/' && new URL(location.href).searchParams.get('next')===${JSON.stringify(path)}`),"anonymous screen uses shared login: "+path);
    assert(await has("Your permission."));
  }
  assert(!requests.some(r=>r.path==="/api/v1/account"),"Anonymous screens must not request account data");
  assert.equal((await fetch(origin+"/auth/login",{redirect:"manual"})).status,404,"Removed login route must not redirect");
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("Your permission."),"homepage sign-in");
  assert.equal(await evaluate("location.pathname"),"/");
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
  await wait(()=>has("Choose your Hail address"),"signup render");
  await wait(async()=>evaluate(`location.hash==='' && document.querySelector('input[maxlength="2048"]')?.value==='fixture-invitation'`),"signup hydration");
  assert.equal(await evaluate(`document.querySelector('[aria-label="Signup steps"] [aria-current=step]').textContent.trim()`),"Your address");
  assert.equal(await evaluate("document.querySelector('nav[aria-label=\"Main navigation\"]')===null"),true,"Signup keeps a focused shell");
  await fill("Your Hail address","alice");await fill("Security email","alice@example.net");await click("Continue");
  await wait(()=>has("How your account is protected"),"protection step");await screenshot("signup-protection");
  await evaluate(`document.querySelector('input[type=checkbox]').click()`);
  await click("Set up recovery");await wait(()=>has("Download recovery kit"),"local generation and provisional preparation");
  assert.equal(publicationAttempts,0);assert.equal(prepareCalls,1);
  secret=await evaluate("document.querySelector('[data-recovery-secret]').textContent");assert.equal(secret.length,43);
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Recovery screen overflows viewport");
  await click("Download recovery kit");
  const packagePath=join(work,"hail-recovery-package.json");
  await wait(async()=>{try{return (await readdir(work)).includes("hail-recovery-package.json");}catch{return false;}},"single recovery download");
  const kit=JSON.parse(await readFile(packagePath,"utf8"));assert(/^did:plc:[a-z2-7]{24}$/.test(kit.vault.did));
  await evaluate(`document.querySelector('input[type=checkbox]').click()`);
  await click("I’ve saved both");await wait(()=>has("Check your saved recovery kit"),"verify screen");
  assert.equal(await evaluate("document.querySelector('[data-recovery-secret]')===null"),true,"Generated secret is no longer shown during verification");
  // Reload before verification: use the original downloaded kit, with no second save.
  await cdp("Page.reload");await wait(()=>has("Encrypted setup was found"),"unverified setup resume");
  await fill("Saved recovery secret",secret);await click("Continue setup");await wait(()=>has("Check your saved recovery kit"),"resume at verification");
  await screenshot("signup-verify");
  await upload("Saved recovery kit",packagePath);
  await fill("Saved recovery secret","A".repeat(43));await click("Verify and continue");
  await wait(()=>has("could not finish"),"wrong-secret refusal");assert(!recoveryVerified);assert.equal(publicationAttempts,0);
  await fill("Saved recovery secret",secret);await click("Verify and continue");await wait(()=>has("Verify your security email"),"kit verification and automatic email");
  await fill("Eight-digit code","12345678");await click("Verify email");await wait(()=>has("Ready to create your account"),"email verification");
  assert.equal(publicationAttempts,0,"Explicit publication confirmation is required");
  const stored=await evaluate("localStorage.getItem('hail.pending-signup.v1')");assert(!stored.includes(secret)&&!stored.includes(setupToken));
  // A clean browser can reopen the one downloaded package before publication.
  await evaluate("localStorage.clear()");await cdp("Page.reload");await wait(()=>has("Choose your Hail address"),"clean browser");
  await click("Continue an interrupted setup");await upload("Recovery kit or pending setup file",packagePath);
  await fill("Saved recovery secret",secret);await click("Continue setup");await wait(()=>has("Ready to create your account"),"resume original identity");
  await click("Create my account");await wait(()=>has("This can take a few minutes"),"monitor wait");await noPrematureSignIn();
  await cdp("Page.reload");await wait(()=>has("Encrypted setup was found"),"monitor resume");
  await fill("Saved recovery secret",secret);await click("Continue setup");await wait(()=>has("Create your passkey"),"automatic activation after resume");
  await noPrematureSignIn();assert(!requests.some(r=>r.path.includes("authentication")),"Authentication requested before enrollment");
  await click("Already created it? Check status");await noPrematureSignIn();
  await click("Create passkey");await wait(()=>has("Try your new passkey"),"real WebAuthn registration");
  await cdp("Page.reload");await wait(()=>has("Encrypted setup was found"),"post-passkey resume");
  await fill("Saved recovery secret",secret);await click("Continue setup");await wait(()=>has("Try your new passkey"),"retained passkey state");
  await click("Sign in and finish");await wait(()=>has("Your account is ready"),"fresh passkey login and retirement");
  assert(retired&&authenticated&&enrolled);assert.equal(prepareCalls,1);assert.equal(publicationAttempts,2);
  assert.equal(await evaluate("localStorage.getItem('hail.pending-signup.v1')"),null);
  assert.equal((await readdir(work)).filter(name=>name.endsWith(".json")).length,1,"Only one package download is required");
  const switchRegistration=async(mode:"invite"|"public")=>{
    await wait(async()=>evaluate(`document.querySelector('#public-registration')?.disabled===false`),'registration switch ready');
    await evaluate(`document.querySelector('#public-registration').focus()`);
    await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:" ",code:"Space",windowsVirtualKeyCode:32});
    await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:" ",code:"Space",windowsVirtualKeyCode:32});
    await wait(async()=>signupMode===mode&&await evaluate(`document.querySelector('#public-registration')?.disabled===false && document.querySelector('#public-registration').checked===${mode==='public'}`),'registration switch saved '+mode);
    assert(!await has('Current mode:'));
    const ax=await cdp("Accessibility.getFullAXTree");
    const control=ax.nodes.find((node:any)=>node.role?.value==='switch'&&node.name?.value==='Public registration');
    assert(control,'Registration switch has an accessible name');
    assert.equal(control.properties.find((property:any)=>property.name==='checked')?.value.value,String(mode==='public'));
    assert(control.description?.value.includes('When off, signup requires an invitation.'));
  };
  if(process.env.HAIL_REGISTRATION_CHECK_ONLY==="true"){
    await cdp("Page.navigate",{url:origin+"/admin"});await wait(()=>has('Your Hail server'),'admin registration');
    await switchRegistration('public');assert.equal(signupMode,'public');
    await switchRegistration('invite');
    await switchRegistration('public');
    await screenshot('admin-registration');
    authenticated=false;await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
    await cdp("Page.navigate",{url:origin});await wait(()=>has('Create an account'),'public homepage link');
    await cdp("Page.navigate",{url:origin+"/signup"});await wait(()=>has('Choose your Hail address'),'public signup');
    assert.equal(await evaluate(`document.querySelector('input[maxlength="2048"]')===null`),true);
    await screenshot('public-signup');passed=true;
    console.info('PASS: Chromium invite signup, admin public registration switch and public signup presentation (local API fixtures)');
  }else{
  await evaluate(`[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Open your inbox').click()`);
  await wait(()=>has("No messages yet"),"completed alpha account inbox");
  assert(await evaluate(`document.querySelector('.account-popover').textContent.includes("alice@provider.example.com")`));
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current=page]').textContent.trim()`),"Inbox");
  assert(!await has("Account details"),"Account metadata must not clutter the feed");
  await cdp("Page.navigate",{url:origin+"/?next=%2F"});
  await wait(()=>has("Your permission."),"existing sessions can sign in again on homepage");
  assert(await evaluate(`!document.querySelector('nav[aria-label="Main navigation"]')`),"Fresh sign-in uses the public shell");
  await click("Sign in with a passkey");await wait(()=>has("No messages yet"),"fresh homepage sign-in returns to inbox");

  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Empty feed overflows viewport");
  if(process.env.HAIL_WIZARD_MOBILE!=="true")assert(await evaluate("document.querySelector('.sidebar').getBoundingClientRect().right<=document.querySelector('main').getBoundingClientRect().left"),"Desktop sidebar overlaps content");
  else {
    assert(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).display==='none' && !document.querySelector('dialog').open`),"Mobile sidebar starts closed");
    await evaluate(`document.querySelector('[aria-label="Open navigation"]').focus();document.querySelector('[aria-label="Open navigation"]').click()`);
    await wait(async()=>evaluate(`document.querySelector('dialog').open`),"mobile drawer opens");
    assert(await evaluate(`Array.from(document.querySelectorAll('dialog nav a')).every(a=>a.getBoundingClientRect().right<=innerWidth && a.getBoundingClientRect().height>=44)`),"Drawer links are touch-sized and fit");
    assert(await evaluate(`document.body.style.overflow==='hidden'`),"Drawer locks background scrolling");
    for(let i=0;i<16;i++){await cdp("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});await cdp("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});assert(await evaluate(`document.querySelector('dialog').contains(document.activeElement)||document.activeElement===document.body`),"Modal keeps keyboard focus out of the background");}
    await screenshot("navigation");await escape();
    await wait(async()=>evaluate(`!document.querySelector('dialog').open`),"Escape closes drawer");
    assert(await evaluate(`document.activeElement?.getAttribute('aria-label')==='Open navigation'`),"Drawer restores focus to trigger");
    await evaluate(`document.querySelector('[aria-label="Open navigation"]').focus();document.querySelector('[aria-label="Open navigation"]').click()`);await pointer(380,200);
    await wait(async()=>evaluate(`!document.querySelector('dialog').open`),"Outside click closes drawer");
    await evaluate(`document.querySelector('[aria-label="Open navigation"]').focus();document.querySelector('[aria-label="Open navigation"]').click();document.querySelector('dialog a[href="/sent"]').click()`);
    await wait(async()=>evaluate(`location.pathname==='/sent'&&!document.querySelector('dialog').open`),"Drawer closes after navigation");
    await evaluate(`document.querySelector('[aria-label="Open navigation"]').focus();document.querySelector('[aria-label="Open navigation"]').click();document.querySelector('dialog nav a[href="/"]').click()`);
    await wait(()=>has("No messages yet"),"return through mobile drawer");
  }
  await accountNavigation();
  const navigateInboxView=async(href:string)=>{
    if(process.env.HAIL_WIZARD_MOBILE==="true")await evaluate(`document.querySelector('[aria-label="Open navigation"]').click()`);
    await evaluate(`Array.from(document.querySelectorAll('nav[aria-label="Main navigation"] a')).find(a=>a.getAttribute('href')===${JSON.stringify(href)}&&a.checkVisibility()).click()`);
  };
  await navigateInboxView('/?view=connections');
  await wait(async()=>evaluate(`location.search==='?view=connections' && document.querySelector('h1').textContent==='Messages'`),"open Messages from navigation");
  assert.equal(await evaluate(`document.title`),"Messages · Haili");
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]').textContent.trim()`),"Messages");
  assert(await evaluate(`!document.querySelector('[aria-label="Inbox views"]')`),"Messages has no tabs");
  assert(await evaluate(`document.querySelectorAll('main a[href="/compose?audience=connections"]').length===1`),"Messages has exactly one New message action, including when empty");
  assert(!await has("Message a connection"));
  await screenshot("messages-empty");
  await navigateInboxView('/');
  await wait(async()=>evaluate(`location.search==='' && document.querySelector('h1').textContent==='Inbox'`),"open Inbox from navigation");
  assert.equal(await evaluate(`document.title`),"Inbox · Haili");
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current="page"]').textContent.trim()`),"Inbox");
  assert(await evaluate(`!document.querySelector('[aria-label="Inbox views"]') && !document.querySelector('main a[href="/compose?audience=connections"]')`),"Inbox has no tabs or connection-message action");
  await screenshot("feed-empty");
  await openAccount();await screenshot("account-menu");await escape();
  await wait(async()=>evaluate(`!document.querySelector('[popover]:popover-open')`),"Escape closes account menu");
  assert(await evaluate(`document.activeElement?.getAttribute('aria-label')==='Open account menu'`),"Account menu restores focus");
  await openAccount();await pointer(process.env.HAIL_WIZARD_MOBILE==='true'?20:600,200);
  await wait(async()=>evaluate(`!document.querySelector('[popover]:popover-open')`),"Outside click closes account menu");
  await openAccount();await evaluate(`document.querySelector('[popover]:popover-open a[href="/account"]').click()`);
  await wait(()=>has("Key custody"),"Account page holds identity details");
  assert(await has("alice@provider.example.com"));assert(await has(did!));
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Account page fits");
  await accountNavigation();
  assert.equal(await evaluate(`document.querySelectorAll("main a").length`),0,"Account has no cross-link cards");
  await narrowLayouts();await screenshot("account");
  if(process.env.HAIL_WIZARD_THEME_ONLY === "true") {
  await openAccount();await evaluate(`document.querySelector('[popover]:popover-open a[href="/settings"]').click()`);
  await wait(async()=>evaluate(`document.querySelector('#theme')?.disabled===false`),"appearance settings ready");
  const appearance=async(value:string)=>{await evaluate(`(()=>{const select=document.querySelector('#theme');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);};
  const scheme=()=>evaluate(`getComputedStyle(document.documentElement).colorScheme`);
  await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
  await wait(async()=>await scheme()==="dark","system dark appearance");
  await appearance("light");assert.equal(await scheme(),"light","explicit light overrides dark OS");
  await appearance("dark");assert.equal(await scheme(),"dark");
  assert.equal(await evaluate(`getComputedStyle(document.body).backgroundColor`),"rgb(17, 26, 28)");
  await narrowLayouts();await screenshot("settings-dark");
  await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"light"}]});
  assert.equal(await scheme(),"dark","explicit dark overrides light OS");
  // Check the CSP-authorized head script before deferred hydration completes.
  const prepaint=await cdp("Page.addScriptToEvaluateOnNewDocument",{source:`document.addEventListener('DOMContentLoaded',()=>{window.themeAtDOMContentLoaded=document.documentElement.dataset.theme;},{once:true});`});
  await evaluate("document.documentElement.dataset.beforeThemeReload='true'");
  await cdp("Page.reload");
  await wait(async()=>evaluate(`!document.documentElement.dataset.beforeThemeReload && document.querySelector('#theme')?.disabled===false`),"appearance reload");
  assert.equal(await evaluate(`window.themeAtDOMContentLoaded`),"dark","theme applied before hydration");
  assert.equal(await evaluate(`document.querySelector('#theme').value`),"dark");
  await cdp("Page.removeScriptToEvaluateOnNewDocument",{identifier:prepaint.identifier});
  await appearance("system");assert.equal(await scheme(),"light");
  await cdp("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
  await wait(async()=>await scheme()==="dark","live system appearance change");
  // Keep a persisted dark override for the blocked-storage/reload checks.
  await appearance("dark");

  const blockedThemeStorage=await cdp("Page.addScriptToEvaluateOnNewDocument",{source:`Storage.prototype.getItem=Storage.prototype.setItem=()=>{throw new DOMException('Storage blocked','SecurityError');};`});
  await cdp("Page.navigate",{url:origin+"/settings"});
  await wait(async()=>evaluate(`document.querySelector('#theme')?.disabled===false`),"appearance with blocked storage ready");
  await appearance("light");await wait(()=>has("Applied for this visit."),"appearance with blocked storage feedback");
  assert.equal(await scheme(),"light");
  await openAccount();await evaluate(`document.querySelector('[popover]:popover-open a[href="/account"]').click()`);
  await wait(()=>has("Key custody"),"account navigation with blocked storage");
  assert.equal(await scheme(),"light","in-memory appearance survives client navigation");
  await cdp("Page.removeScriptToEvaluateOnNewDocument",{identifier:blockedThemeStorage.identifier});
  await cdp("Page.navigate",{url:origin+"/account"});await wait(()=>has("Key custody"),"persisted dark appearance restored");
  assert.equal(await scheme(),"dark");await screenshot("account-dark");
  assert(!browserErrors.some(error=>/Content Security Policy|Refused to execute|hydration/i.test(error)),"Theme has no CSP or hydration errors");
  passed=true;console.info("PASS: Chromium appearance settings, system changes, persistence, pre-paint initialization and blocked storage");
  } else {
  // The public homepage now performs the passkey ceremony directly.
  await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("Your permission."),"signed-out homepage");
  await click("Sign in with a passkey");await wait(()=>has("No messages yet"),"homepage passkey signs in without an intermediate page");
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
  await cdp("Page.navigate",{url:origin+"/"});await wait(()=>has("The latest from your senders."),"return to inbox");
  const feedImage='[aria-label="Messages"] img[alt="Bundled test header"]';
  await wait(async()=>evaluate(`!!document.querySelector(${JSON.stringify(feedImage)})`),"feed header ready");
  assert(await evaluate(`document.querySelector(${JSON.stringify(feedImage)}).src.startsWith('data:image/png;base64,')`),"Feed header remains bundled");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Populated feed overflows viewport");
  await screenshot("feed");
  const settings=async()=>{await openAccount();await evaluate(`document.querySelector('[popover]:popover-open a[href="/settings"]').click()`);await wait(async()=>evaluate(`document.querySelector('#show-headers')?.disabled===false`),"reading settings ready");};
  const feed=async()=>{await evaluate(`(()=>{const a=document.createElement('a');a.href='/';document.body.append(a);a.click();a.remove();})()`);await wait(()=>has("The latest from your senders."),"feed navigation");};
  await settings();await accountNavigation();assert.equal(await evaluate(`document.querySelectorAll("main a").length`),0,"Settings has no cross-link cards");await narrowLayouts();await screenshot("settings");
  await evaluate(`document.querySelector('#show-headers').click()`);await wait(()=>has("Saved on this browser."),"preference saved");
  await feed();await wait(async()=>evaluate(`!document.querySelector(${JSON.stringify(feedImage)})`),"hide feed headers through settings");
  await evaluate("document.documentElement.dataset.beforePreferenceReload='true'");
  await cdp("Page.reload");await wait(async()=>evaluate(`!document.documentElement.dataset.beforePreferenceReload && !!document.querySelector('[aria-label="Messages"]') && !document.querySelector(${JSON.stringify(feedImage)})`),"persist hidden header preference");
  await evaluate(`document.querySelector('[aria-label="Inbox pages"] a').click()`);
  await wait(async()=>evaluate("new URL(location.href).searchParams.get('after')==='older-page' && !!document.querySelector('[aria-label=\"Inbox pages\"] a[href=\"/\"]')"),"older feed page");
  await evaluate(`document.querySelector('[aria-label="Inbox pages"] a[href="/"]').click()`);
  await wait(async()=>evaluate("location.search==='' && !!document.querySelector('[aria-label=\"Inbox pages\"] a[href*=after]')"),"newest feed page");
  await settings();assert.equal(await evaluate(`document.querySelector('#show-headers').checked`),false);
  await evaluate(`document.querySelector('#show-headers').click()`);await feed();
  await wait(async()=>evaluate(`!!document.querySelector(${JSON.stringify(feedImage)})`),"show feed headers again");
  const blockedStorage=await cdp("Page.addScriptToEvaluateOnNewDocument",{source:`Storage.prototype.getItem=Storage.prototype.setItem=()=>{throw new DOMException('Storage blocked','SecurityError');};`});
  await cdp("Page.navigate",{url:origin+"/settings"});await wait(async()=>evaluate(`document.querySelector('#show-headers')?.disabled===false`),"settings works with blocked storage");
  await evaluate(`document.querySelector('#show-headers').click()`);await wait(()=>has("Applied for this visit."),"storage failure feedback");
  await feed();await wait(async()=>evaluate(`!document.querySelector(${JSON.stringify(feedImage)})`),"in-memory header preference survives navigation without storage");
  await cdp("Page.removeScriptToEvaluateOnNewDocument",{identifier:blockedStorage.identifier});
  await cdp("Page.navigate",{url:origin+"/"});await wait(async()=>evaluate(`!!document.querySelector(${JSON.stringify(feedImage)})`),"restore normal feed preferences");
  await evaluate(`[...document.querySelectorAll('nav a')].find(a=>a.textContent.trim()==='Subscriptions').click()`);
  await wait(()=>has("No subscriptions on this page"),"allowed-sender list");
  assert.equal(await evaluate(`document.querySelector('nav[aria-label="Main navigation"] a[aria-current=page]').textContent.trim()`),"Subscriptions");
  await fill("Potential sender's Hail address",peerAddress);await click("Review sender");await wait(()=>has("Test sender"),"verified sender review");
  await evaluate(`document.querySelector('fieldset input[value=updates]').click()`);
  assert.deepEqual(await styles("fieldset label",["flexDirection","alignItems"]),["row","center"]);
  await click("Review permission");await wait(()=>has("Confirm allowed sender"),"exact permission review");
  assert.deepEqual(await styles('[aria-label="Permission confirmation"]',["borderTopWidth","borderTopColor"]),["2px","rgb(15, 118, 110)"]);
  assert.equal(allowed,null);assert(await has("alice@provider.example.com"));
  await click("Allow sender with my passkey");await wait(()=>has("Unsubscribe"),"passkey-approved permission saved");
  assert.equal(allowed!.status,"active");await click("Unsubscribe");await wait(()=>has("Confirm unsubscribe"),"subscription unsubscribe review");
  await click("Cancel");assert.equal(allowed!.status,"active","Cancel leaves subscription active");
  await cdp("Page.navigate",{url:origin+messagePath});await wait(()=>has("Unsubscribe"),"Inbox reader offers unsubscribe");
  assert(await evaluate(`(()=>{const action=document.querySelector('article > header [aria-label="Sender subscription"] button');const category=document.querySelector('article > header mark');return !!action&&!!category&&action.getBoundingClientRect().top>=category.getBoundingClientRect().bottom;})()`),"Unsubscribe sits in the message header below its category");
  const beforeReaderReview=approvals.size;
  await click("Unsubscribe");await wait(()=>has("Unsubscribe with my passkey"),"reader unsubscribe confirmation");
  assert.equal(allowed!.status,"active","Opening review does not unsubscribe");
  assert.equal(approvals.size,beforeReaderReview+1);
  assert(await has("updates"));assert(await has("Your past messages and connections will stay."));
  await click("Cancel");assert.equal(allowed!.status,"active");
  await click("Unsubscribe");await wait(()=>has("Unsubscribe with my passkey"),"reader review after cancellation");
  await narrowLayouts();await screenshot("unsubscribe-review");
  await click("Unsubscribe with my passkey");await wait(()=>has("Unsubscribed from"),"passkey-confirmed unsubscribe inside reader");
  assert.equal(allowed!.status,"revoked");assert(await has("One-time reply browser transport test"),"Unsubscribe retains message content");
  await cdp("Page.navigate",{url:origin+messagePath});await wait(()=>has("You have no active subscription to this sender."),"reader reflects unsubscribed sender on reload");
  assert(await evaluate(`![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Unsubscribe')`));
  await cdp("Page.navigate",{url:origin+"/permissions"});await wait(()=>has("Unsubscribed"),"Subscriptions uses unsubscribe terminology");
  assert(!await has("Share your sender QR"),"Subscription page does not show publishing tools");
  await cdp("Page.navigate",{url:origin+"/categories"});await wait(()=>has("Create sender profile with passkey"),"first sender profile setup");
  await wait(async()=>evaluate(`document.querySelector('fieldset')?.disabled===false`),"profile editor ready");
  assert(!await has("Show my sender QR"),"QR is offered only after publishing a profile");
  assert(await evaluate(`!!document.querySelector('[aria-label="General category"]') && !document.querySelector('[aria-label="General category"] input, [aria-label="General category"] button')`),"General is built-in with no edit or remove controls");
  await fill("Sender name","Alice's updates");
  profileVerificationMismatch=true;await click("Create sender profile with passkey");
  await wait(()=>has("You verified a different account."),"profile draft cannot be saved to a different passkey account");
  assert.equal(profileWrites,0);profileVerificationMismatch=false;
  await click("Create sender profile with passkey");
  await wait(()=>has("Save changes with passkey"),"profile created through passkey-authenticated save");
  assert.equal(profileWrites,1);assert.deepEqual(ownProfile.profile.categories.map((c:any)=>({id:c.id,label:c.label})),[{id:"general",label:"General"}]);
  await wait(async()=>evaluate(`document.querySelector('fieldset')?.disabled===false`),"saved profile editor ready");
  await click("Add category");
  await evaluate(`(()=>{const fields=document.querySelectorAll('[aria-label="Publishing categories"] input');for(const [index,value] of [[0,'News'],[1,'news']]){fields[index].value=value;fields[index].dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await click("Save changes with passkey");await wait(async()=>profileWrites===2&&await has("Show my sender QR"),"category addition saved");
  await wait(async()=>evaluate(`document.querySelector('fieldset')?.disabled===false`),"updated category editor ready");
  assert.deepEqual(ownProfile.profile.categories.map((c:any)=>c.id),['general','news']);
  assert(await evaluate(`Array.from(document.querySelectorAll('[aria-label="Publishing categories"] input[readonly]')).map(i=>i.value).join(',')==='news'`),"Published category IDs stay stable");
  await evaluate(`document.querySelector('[aria-label="Remove category 1"]').click()`);
  await click("Save changes with passkey");await wait(async()=>profileWrites===3&&await has("Show my sender QR"),"category removal saved");
  await wait(async()=>evaluate(`document.querySelector('fieldset')?.disabled===false`),"removed category editor ready");
  assert.deepEqual(ownProfile.profile.categories.map((c:any)=>c.id),['general']);
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Categories fits viewport");
  await narrowLayouts();await screenshot("categories");
  await click("Show my sender QR");assert(await evaluate("!!document.querySelector('svg[role=img] path')"));
  const qrRequests=requests.filter(r=>r.path.endsWith("/permissions/prepare")).length;
  await cdp("Page.navigate",{url:origin+"/permissions#"+new URLSearchParams({sender:peerAddress,did:peerDid})});
  await wait(()=>has("QR identity pin:"),"scanned sender QR prefill");
  assert.equal(await evaluate(`document.querySelector('input[placeholder="sender@business.example"]').value`),peerAddress);
  assert.equal(requests.filter(r=>r.path.endsWith("/permissions/prepare")).length,qrRequests,"Opening a QR must not prepare or approve a permission");
  await click("Review sender");await wait(()=>has("Test sender"),"QR and typed address share the same review");
  await cdp("Page.navigate",{url:origin+"/compose"});await wait(()=>has("Send a hail"),"publisher styling");
  await selectedAudience("Subscribers");
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
  await wait(()=>has("Message sent."),"provider accepted category message before delivery");assert.equal(composePosts,1);
  assert(!await has("Publication publishing"));assert(!await has("Recent publications"));
  assert(!await has("Refresh status"));assert(!await has("saved audience"));
  await cdp("Page.navigate",{url:origin+"/sent"});
  await wait(()=>has("Sent messages"),"publication links to per-message delivery details");
  await evaluate(`document.querySelector(${JSON.stringify(`a[href="/sent/${composed.messageId}"]`)}).click()`);
  await wait(async()=>evaluate(`location.pathname===${JSON.stringify(`/sent/${composed.messageId}`)} && !!document.querySelector('article h1')`),"sent rich-message reader");
  assert.deepEqual(await rendered('article > div'),previewContent,"Preview and sent reader must render the same safe content");
  // Expired sessions use the same login, preserve the QR fragment, and clear the stale cookie.
  const qrFragment=new URLSearchParams({sender:peerAddress,did:peerDid}).toString();
  await cdp("Network.setCookie",{name:"hail_session",value:"hails_"+"B".repeat(43),url:origin,httpOnly:true,sameSite:"Lax"});
  await cdp("Page.navigate",{url:origin+"/permissions#"+qrFragment});
  await wait(async()=>evaluate(`location.pathname==='/' && new URL(location.href).searchParams.get('next')==='/permissions' && location.hash===${JSON.stringify("#"+qrFragment)}`),"expired-session login preserves QR identity pin");
  const cookies=await cdp("Network.getCookies",{urls:[origin]});assert(!cookies.cookies.some((cookie:any)=>cookie.name==="hail_session"),"Expired cookie must be cleared");
  await click("Sign in with a passkey");await wait(()=>has("QR identity pin:"),"shared passkey login returns to QR review");
  assert.equal(await evaluate(`document.querySelector('input[placeholder="sender@business.example"]').value`),peerAddress);
  assert.equal(requests.filter(r=>r.path.endsWith("/permissions/prepare")).length,qrRequests,"Signing in through a QR must not approve or prepare it");
  // Verify each ordinary folder resumes after login, including its query string.
  for(const [path,text] of [["/sent?after=older","Sent messages"],["/compose","Send a hail"],["/settings/security","Passkeys & security"]]){
    await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
    await cdp("Page.navigate",{url:origin+path});
    await wait(async()=>evaluate(`location.pathname==='/' && new URL(location.href).searchParams.get('next')===${JSON.stringify(path)}`),"folder login: "+path);
    await click("Sign in with a passkey");
    await wait(async()=>evaluate(`location.pathname+location.search===${JSON.stringify(path)} && document.body.innerText.includes(${JSON.stringify(text)})`),"resume folder: "+path);
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),path+" overflows viewport");
  }
  assert(!await has("Recovery is separate"));
  await accountNavigation();
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
  await click("Review permission");await wait(()=>has("Confirm allowed sender"),"review General subscription");
  assert(await has("Scope: General"));await click("Allow sender with my passkey");
  await wait(async()=>evaluate(`[...document.querySelectorAll('[aria-label="Issued permissions"] article p')].some(p=>p.textContent.startsWith('General · active'))`),"new General subscription saved");
  assert.equal(allowed!.revision,1);assert.deepEqual(allowed!.scope,[{type:"categories",values:["general"]}]);
  // Separate permanent/expiring codes and real browser passkey confirmation (API fixtures).
  await cdp("Page.navigate",{url:origin+"/connections?connections=1"});await wait(()=>has("Create my personal code"),"personal connection code creation");
  await click("Create my personal code");await wait(()=>has("Confirm new connection link"),"standing invitation consent");
  assert(await has("Connections permit personal messages while active"));assert(await has("No automatic expiry"));
  assert(!await has("Continue interrupted review"));assert(!await has("Check original status"));
  const pendingCodeReview=await evaluate(`sessionStorage.getItem('hail.connection-approval.v1')`);
  const connectionCommitsBefore=requests.filter(r=>r.path==="/api/v1/account/connections/commit").length;
  await cdp("Page.reload");await wait(()=>has("Confirm new connection link"),"pending code review restored automatically");
  assert.equal(await evaluate(`sessionStorage.getItem('hail.connection-approval.v1')`),pendingCodeReview);
  assert.equal(requests.filter(r=>r.path==="/api/v1/account/connections/commit").length,connectionCommitsBefore,"Restoring a review must not authorize it");
  connectionCommitLost=true;
  await click("Confirm");await wait(()=>has("We couldn’t confirm whether your connection change was saved."),"uncertain save exposes retry");
  assert.equal(connectionCodes.length,1);
  assert(!await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel')`),"Uncertain save cannot be discarded");
  await click("Try again");await wait(()=>has("Show QR & link"),"saved result recovered without another passkey");
  assert.equal(requests.filter(r=>r.path==="/api/v1/account/connections/commit").length,connectionCommitsBefore+1,"Recovery must not repeat the saved action");
  await click("Show QR & link");await wait(async()=>evaluate(`!!document.querySelector('svg[aria-label="Connection QR code"]')`),"local QR rendering");
  assert(await evaluate(`(()=>{const card=document.querySelector('[aria-label="Your personal code"]'),button=[...card.querySelectorAll('button')].find(b=>b.textContent==='Hide QR & link');return !!card.querySelector('svg[aria-label="Connection QR code"]')&&button?.getAttribute('aria-expanded')==='true'&&card.contains(document.getElementById(button.getAttribute('aria-controls')));})()`),"Personal QR and its toggle must stay in the personal card");
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"),"Connection QR overflows viewport");
  await click("Hide QR & link");await wait(async()=>evaluate(`!document.querySelector('svg[aria-label="Connection QR code"]')`),"same button hides personal QR");
  await click("Show QR & link");await wait(()=>has("Hide QR & link"),"same button reopens personal QR");await click("Hide QR & link");
  await fill("Private label","Conference");
  await fill("Expires (your local time)","2027-01-15T18:00");await click("Review");await wait(()=>has("Confirm new connection link"),"expiring code review");
  await click("Confirm");await wait(async()=>connectionCodes.length===2&&await has("Saved. Existing subscriptions are unchanged."),"expiring code saved");
  assert.equal(connectionCodes.length,2);assert.equal(connectionCodes.filter(code=>code.personal).length,1);
  assert(connectionCodes.find(code=>!code.personal)!.expiresAt!>0);assert.equal(connectionCodes.find(code=>code.personal)!.expiresAt,null);
  await evaluate(`[...document.querySelectorAll("article button")].find(b=>b.textContent==="Show QR & link").click()`);await wait(async()=>evaluate(`!!document.querySelector('article svg[aria-label="Connection QR code"]')`),"expiring QR stays in its own card");
  await click("Show QR & link");await wait(async()=>evaluate(`!!document.querySelector('[aria-label="Your personal code"] svg')&&!document.querySelector('article svg[aria-label="Connection QR code"]')`),"switching codes moves the inline panel to the selected card");
  await click("Hide QR & link");
  await click("Replace");await wait(()=>has("Confirm personal code replacement"),"personal replacement review");
  await click("Confirm");await wait(()=>has("Saved. Existing subscriptions are unchanged."),"replacement committed");
  assert.equal(connectionCodes.length,2);
  await cdp("Network.deleteCookies",{name:"hail_session",url:origin});
  const invitationLink=origin+"/connect#"+new URLSearchParams({id:fixtureInvitationId,did:peerDid,token:fixtureAdmissionToken});
  await cdp("Page.navigate",{url:invitationLink});await wait(()=>has("Sign in to review"),"signed-out scanner consent");
  await wait(async()=>evaluate("location.hash===''"),"admission token removed from URL");
  await evaluate(`document.querySelector('a[href="/?next=%2Fconnect"]').click()`);await wait(()=>has("Your permission."),"scanner login");
  assert.equal(await evaluate("new URL(location.href).searchParams.get('next')"),"/connect");
  await click("Sign in with a passkey");await wait(()=>has("Add connection"),"scanner automatically loads exact connection consent after login");
  assert(await has(peerDid));assert(await has(peerAddress));assert(!personalConnection);
  assert(!await has("Review connection code"));assert(!await has("Review before connecting"));
  const preparedConnections=[...connectionApprovals.values()].filter(row=>row.action==="connect").length;
  await cdp("Page.reload");await wait(()=>has("Add connection"),"pending connection review restored without extra steps");
  assert.equal([...connectionApprovals.values()].filter(row=>row.action==="connect").length,preparedConnections);
  assert(!personalConnection);await click("Add connection");await wait(()=>has("Connection saved"),"one click confirms mutual connection");
  await cdp('Page.navigate',{url:origin+'/compose?audience=connections'});await wait(()=>has('Send a message'),'connection composer uses existing editor');
  await selectedAudience("Connections");
  await wait(async()=>evaluate(`document.querySelectorAll('input[name="connection"]').length===2`),'connection recipient picker');
  assert(!await evaluate(`!!document.querySelector('select[name="category"]')||!!document.querySelector('input[name="allowReply"]')`));
  await evaluate(`document.querySelectorAll('input[name="connection"]').forEach(e=>e.click());document.querySelector('input[value="plain"]').click()`);
  await evaluate(`(()=>{const e=document.querySelector('textarea[name=text]');e.value='Personal message to chosen connections';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await click('Send →');
  await wait(()=>has('Message batch not confirmed'),'ambiguous connection acceptance retains the original intent');
  assert(await evaluate(`document.querySelector('textarea[name=text]').value==='Personal message to chosen connections'&&document.querySelectorAll('input[name="connection"]:checked').length===2`),'Connection retry must retain body and recipients');
  assert(!await has('Message sent.'),'Lost acceptance response must not show success');
  await click('Send →');await wait(()=>has('Message sent.'),'provider accepted connection message before delivery');
  assert(!await has('Message batch publishing'));assert(!await has('Recent messages'));assert(!await has('Refresh status'));
  assert.equal(connectionSent.length,2);assert.equal(composePosts,1);assert.deepEqual(allowed!.scope,[{type:'categories',values:['general']}]);
  connectionIncoming=true;
  await cdp('Page.navigate',{url:origin+'/?view=connections'});await wait(()=>has('A personal connection reply'),'connection message uses existing reader preview');
  assert(!await has('One-time reply browser transport test'));
  await evaluate(`document.querySelector('a[href*="${connectionIncomingId}"]').click()`);await wait(()=>has('Message this connection →'),'standing connection response action');
  assert(await evaluate(`!document.querySelector('[aria-label="Sender subscription"]')`),"Connection messages never offer unsubscribe");
  assert(!await evaluate(`!!document.querySelector('form[action="?/reply"]')`));
  await evaluate(`document.querySelector('a[href*="audience=connections&connection="]').click()`);await wait(async()=>evaluate(`document.querySelectorAll('input[name="connection"]:checked').length===1`),'connection response preselects the same active connection');
  await cdp("Page.navigate",{url:origin+"/connections?connected=1"});await wait(()=>has("Remove connection"),"connected account visible");
  await click("Remove connection");await wait(()=>has("Confirm connection removal"),"disconnect review");await click("Confirm");await wait(()=>has("No connections yet."),"disconnect saved");
  assert(!personalConnection);assert.equal(allowed!.status,"active");
  await cdp('Page.navigate',{url:origin+`/message/${encodeURIComponent(peerDid)}/${connectionIncomingId}`});await wait(()=>has('This connection is no longer active.'),'disconnected historical messages remain readable without a standing send action');
  const savedConnectionReview=[...connectionApprovals.values()].find(row=>row.action==="connect")!;
  await evaluate(`sessionStorage.setItem('hail.connection-approval.v1',${JSON.stringify(savedConnectionReview.requestId)})`);
  await cdp("Page.navigate",{url:origin+"/connect"});await wait(()=>has("It was not reopened."),"historical success does not masquerade as a live connection");assert(!personalConnection);
  federatedConnecting=true;federationPolls=0;
  await cdp("Page.navigate",{url:invitationLink});await wait(()=>has("Add connection"),"signed-in invite automatically loads federated consent");
  assert(await has(peerDid));assert(!personalConnection);await click("Add connection");
  await wait(()=>has("Connecting across providers."),"durable cross-provider pending state");assert(!personalConnection);
  await cdp("Page.navigate",{url:origin+"/connections?federation-pending=1"});await wait(()=>has("Synchronizing with other providers"),"pending work discoverable after closing scanner page");
  await wait(()=>has("Remove connection"),"automatic federation status polling discovers completed connection");assert(personalConnection);
  await click("Remove connection");await wait(()=>has("Confirm connection removal"),"federated disconnect consent");await click("Confirm");await wait(()=>has("No connections yet."),"federated disconnect visible");
  federatedConnecting=false;
  ownerConnectionSigning=true;
  await cdp("Page.navigate",{url:origin+"/connections?owner-signing=1"});await wait(()=>has("Create an expiring connect link"),"owner-signing code form");
  await fill("Private label","Owner identity proof");await fill("Expires (your local time)","2027-01-15T18:00");await click("Review");
  await wait(()=>has("Sign with your own identity key"),"owner consent requires local signature");
  const ownerRow=[...connectionApprovals.values()].find(row=>row.ownerSigning)!;
  await click("Download consent proposal");await wait(async()=>{try{return (await readdir(work)).includes(`hail-connection-${ownerRow.requestId}.json`);}catch{return false;}},"owner proposal download");
  const downloaded=JSON.parse(await readFile(join(work,`hail-connection-${ownerRow.requestId}.json`),"utf8"));assert.deepEqual(downloaded,JSON.parse(JSON.stringify(ownerRow.ownerSigning)));
  const wrongUpload=join(work,"not-consent.json");await writeFile(wrongUpload,JSON.stringify({type:"hailp.user-vault",ciphertext:"must-stay-local"}));
  await upload("Signed consent file",wrongUpload);await wait(()=>has("not a vault or backup"),"browser rejects a vault before uploading");
  assert(!requests.some(r=>r.body.includes("must-stay-local")));
  const ownerPayload=fromDiagnosticJson("hail.connection-invitation",downloaded.payload);
  const ownerCose=await signPayload("hail.connection-invitation",ownerPayload,createWebCryptoSigner(ownerPayload.key_id,permissionSigner.privateKey));
  const ownerPath=join(work,"owner-consent.cose");await writeFile(ownerPath,ownerCose);
  await upload("Signed consent file",ownerPath);await wait(()=>has("Signed file ready."),"browser accepts exact signed consent file");
  const originalCodes=connectionCodes.length;await click("Confirm");await wait(async()=>connectionCodes.length===originalCodes+1&&await has("Saved. Existing subscriptions are unchanged."),"owner signed file and passkey submission");
  assert.equal(JSON.parse(requests.filter(r=>r.path==="/api/v1/account/connections/commit").at(-1)!.body).cose,encodeBase64Url(ownerCose));
  assert.equal(composePosts,1);assert.equal(replyPosts,1);
  for(const req of requests){assert(!req.body.includes(secret),"Recovery secret uploaded");assert(!req.body.includes('"ciphertext"'),"Recovery vault uploaded");}
  assert(requests.filter(r=>r.authorization).every(r=>r.authorization==="Bearer "+setupToken||r.path.endsWith("check-address")));
  // Inbox and connection messages share Trash but restore to their original feeds.
  const mailboxPage=async(path:string,heading:string)=>{
    await evaluate(`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(path)};document.body.append(a);a.click();a.remove();})()`);
    await wait(async()=>evaluate(`location.pathname+location.search===${JSON.stringify(path)} && document.querySelector('main h1')?.textContent===${JSON.stringify(heading)}`),'mailbox page '+heading);
  };
  await mailboxPage('/','Inbox');await wait(()=>has('Delete message'),'inbox delete available');
  await click('Delete message');await wait(()=>has('Move to Trash'),'trash deletion review');await click('Move to Trash');await wait(()=>has('No messages yet'),'inbox deletion hides message');
  await mailboxPage('/?view=connections','Messages');await wait(()=>has('Delete message'),'connection delete available');
  await click('Delete message');await wait(()=>has('Move to Trash'),'connection deletion review');await click('Move to Trash');await wait(()=>has('No messages yet'),'connection deletion hides message');
  await mailboxPage('/trash','Trash');await wait(()=>has('Restore selected'),'trash page');
  assert(await has('Restore to Inbox'));assert(await has('Restore to Messages'));
  await wait(async()=>evaluate(`document.querySelector('main input[type=checkbox]')?.disabled===false`),'Trash selection ready');
  await evaluate(`document.querySelector('main input[type=checkbox]').click()`);await click('Restore selected');await wait(()=>has('Trash is empty.'),'bulk restore');
  await mailboxPage('/?view=connections','Messages');await wait(()=>has('A personal connection reply'),'restore returns to Messages');
  await mailboxPage('/','Inbox');await wait(()=>has('Delete message'),'restore returns to Inbox');
  await click('Delete message');await wait(()=>has('Move to Trash'),'second trash review');await click('Move to Trash');await wait(()=>has('No messages yet'),'second trash deletion');
  await mailboxPage('/settings','Settings');await wait(async()=>evaluate(`document.querySelector('#use-trash')?.disabled===false`),'account Trash preference');
  await evaluate(`document.querySelector('#use-trash').click()`);await click('Disable Trash and delete contents');await wait(()=>has('Trash disabled.'),'disable purges existing trash');
  assert.equal(trashed.size,0);assert(deleted.has(incomingId));
  await mailboxPage('/?view=connections','Messages');await wait(()=>has('Delete message'),'permanent delete entry');
  await click('Delete message');await wait(()=>has('Delete permanently'),'disabled trash warning');await click('Delete permanently');await wait(()=>has('No messages yet'),'immediate permanent deletion');
  await mailboxPage('/trash','Trash');await wait(()=>has('Trash is empty.'),'disabled Trash has no deleted messages');
  await mailboxPage('/admin','Your Hail server');
  await switchRegistration('public');
  assert.equal(signupMode,'public');
  await switchRegistration('invite');
  await switchRegistration('public');
  await screenshot('admin-registration');
  await openAccount();
  await evaluate(`document.querySelector('[popover]:popover-open form button').click()`);
  await wait(()=>has("Couldn’t sign out. Please try again."),"logout failure offers retry");
  assert(authenticated,"Failed logout retains the session");
  await evaluate(`document.querySelector('[popover]:popover-open form button').click()`);
  await wait(async()=>evaluate(`location.pathname==='/'&&document.body.innerText.includes('Your permission.')`),"avatar menu signs out to homepage");
  assert(!authenticated);assert(requests.some(r=>r.path==='/api/v1/auth/logout'));
  const loggedOut=await cdp("Network.getCookies",{urls:[origin]});assert(!loggedOut.cookies.some((cookie:any)=>cookie.name==='hail_session'),"Sign-out clears session cookie");
  await wait(()=>has('Create an account'),'public homepage signup link');
  await cdp("Page.navigate",{url:origin+"/signup"});
  await wait(()=>has('Choose your Hail address'),'public signup form');
  assert.equal(await evaluate(`document.querySelector('input[maxlength="2048"]')===null`),true,'Public signup does not require an invitation');
  await screenshot('public-signup');
  passed=true;
  console.info("PASS: Chromium public/private shells, sign-in return paths and QR pins, signup, messaging, permissions and security (local API fixtures only)");
  }
  }
}finally{
  socket?.close();chrome?.kill();gui?.kill();server.stop(true);
  if(chrome)await chrome.exited;if(gui)await gui.exited;
  if(!passed&&gui)console.error((await new Response(gui.stderr).text()).slice(-2000));
  if(!passed)console.error(browserErrors.slice(-5).join("\n"));
  provider.recoverySecret.fill(0);messaging.recoverySecret.fill(0);secret="";
  await rm(work,{recursive:true,force:true});
}
