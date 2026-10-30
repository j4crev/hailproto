// Real CLI processes and HTTPS, isolated behind a loopback-only CONNECT fixture.
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createServer} from "node:http";
import {connect} from "node:net";
import {createUserVault,cipher,unlockIdentityKey} from "../../../packages/hail-client-support/src/vault-crypto.ts";
const {encodeDeterministic,decodeDeterministic}=await import(Bun.resolveSync("@hailproto/codec",new URL("../../cli",import.meta.url).pathname));
const {verifySignature}=await import(Bun.resolveSync("@atproto/crypto",new URL("../../cli",import.meta.url).pathname));
const {encode}=await import(Bun.resolveSync("@ipld/dag-cbor",new URL("../../cli",import.meta.url).pathname));
const {cidForCbor}=await import(Bun.resolveSync("@atproto/common",new URL("../../cli",import.meta.url).pathname));
const root=resolve(import.meta.dir,"../../.."),binary=resolve(Bun.argv[2]??join(root,"apps/cli/target/debug/hailp"));
const directory=await mkdtemp(join(tmpdir(),"hailp-transfer-e2e-"));
const source="https://source.example.com",destination="https://destination.example.com",id="019a0000-0000-7000-8000-000000000001",did=`did:plc:${"a".repeat(24)}`,token=`hailp_${"a".repeat(43)}`;
const hash=(bytes:Uint8Array)=>new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest());
const b64=(bytes:Uint8Array)=>Buffer.from(bytes).toString("base64url");
let server:ReturnType<typeof Bun.serve>|undefined,handler:(r:Request)=>Promise<Response>,cases=0;
const sockets=new Set<any>();const proxy=createServer();
async function checked(args:string[]){const p=Bun.spawn(args,{stdout:"pipe",stderr:"pipe"});const [code,err]=await Promise.all([p.exited,new Response(p.stderr).text()]);assert.equal(code,0,err);}
try{
 const ca=join(directory,"ca.pem"),caKey=join(directory,"ca-key.pem"),key=join(directory,"key.pem"),csr=join(directory,"csr"),cert=join(directory,"cert.pem"),ext=join(directory,"ext");
 await checked(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=transfer-test-ca","-addext","basicConstraints=critical,CA:TRUE","-keyout",caKey,"-out",ca]);
 await checked(["openssl","req","-new","-newkey","rsa:2048","-nodes","-subj","/CN=source.example.com","-keyout",key,"-out",csr]);
 await writeFile(ext,"subjectAltName=DNS:source.example.com,DNS:destination.example.com\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n");
 await checked(["openssl","x509","-req","-in",csr,"-CA",ca,"-CAkey",caKey,"-CAcreateserial","-days","1","-extfile",ext,"-out",cert]);
 server=Bun.serve({hostname:"127.0.0.1",port:0,tls:{key:Bun.file(key),cert:Bun.file(cert)},fetch:r=>handler(r)});
 proxy.on("connect",(req,socket,head)=>{
  assert(["source.example.com:443","destination.example.com:443"].includes(req.url!));
  const upstream=connect(server!.port!,"127.0.0.1",()=>{socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
  for(const s of [socket,upstream]){sockets.add(s);s.on("close",()=>sockets.delete(s));s.on("error",()=>{socket.destroy();upstream.destroy();});}
 });
 await new Promise<void>(resolve=>proxy.listen(0,"127.0.0.1",resolve));
 const proxyUrl=`http://127.0.0.1:${(proxy.address() as any).port}`;
 const credential=join(directory,"credential.json");await writeFile(credential,JSON.stringify({type:"hailp.api-credential",version:1,provider:source,accountId:id,token}),{mode:0o600});
 const env={...process.env,HAILP_CREDENTIAL_FILE:credential,SSL_CERT_FILE:ca,NODE_EXTRA_CA_CERTS:ca,HTTPS_PROXY:proxyUrl,https_proxy:proxyUrl,HTTP_PROXY:proxyUrl,http_proxy:proxyUrl,ALL_PROXY:"",all_proxy:"",NO_PROXY:"",no_proxy:""};
 const commands=[[binary]];
 for(const [index,command] of commands.entries())for(const managed of [false,true]){
  const generated=await createUserVault();generated.vault.did=did;const sourceKeys=await createUserVault(),sourceMessage=await createUserVault(),targetKeys=await createUserVault(),targetMessage=await createUserVault();
  const secret=b64(generated.recoverySecret),prefix=join(directory,`flow-${index}-${managed}`),vp=prefix+".vault",statePath=prefix+".state",sp=prefix+".snapshot",opPath=prefix+".operation",approvalPath=prefix+".approval",bindingPath=prefix+".binding",monitorPath=prefix+".monitor";
  await writeFile(vp,JSON.stringify(generated.vault),{mode:0o600});await writeFile(monitorPath,JSON.stringify({payload:b64(encodeDeterministic({fixture:true})),signature:b64(new Uint8Array(64))}),{mode:0o600});
  const sourceSigner=await unlockIdentityKey(sourceMessage.vault,await cipher(sourceMessage.recoverySecret)),targetSigner=await unlockIdentityKey(targetMessage.vault,await cipher(targetMessage.recoverySecret));
  async function sign(value:any,key:CryptoKey){const payload=encodeDeterministic(value);const signature=await crypto.subtle.sign("Ed25519",key,Buffer.concat([Buffer.from(value.type+".v1\0"),payload]));return {payload:b64(payload),signature:b64(new Uint8Array(signature))};}
  let fenced=false,fail="",grant:any,grantWire:any,offer:any,ack:any,reservation:any,selectionWire:any,snapshot:any,activation:any,cancelReceipt:any;
  const calls:any[]=[];const group=managed?"managed-transfer":"transfer";
  const status=()=>({type:managed?"hailp.managed-transfer-status":"hailp.transfer-status",version:1,provider:source,accountId:id,did,phase:"offer-ready",originConfirmed:true,transferId:id,nonce:grant?.nonce,destinationServiceBase:destination+"/hail",offer,...managed?{acknowledgement:ack}:{}});
  handler=async(request)=>{
   const url=new URL(request.url),path=url.pathname,body=request.method==="POST"?await request.json():null;calls.push({origin:url.origin,path,body});
   const target=path.startsWith("/.well-known/");assert.equal(request.headers.get("authorization"),target?null:`Bearer ${token}`);assert.equal(request.headers.get("cookie"),null);
   const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{"Content-Type":target?"application/hail-transfer+json":"application/json"}});
   if(path==="/api/v1/account")return json({type:"hailp.account",version:1,provider:source,accountId:id,did,address:"alice@source.example.com",custodyProfile:managed?"managed":"owner-controlled",migrationState:fenced?"fenced":null,monitorVerificationMode:"strict-public-v1",managedProfileVersion:managed?"hail-managed-custody-v1":null,identityPublicKey:managed?sourceKeys.vault.identity.publicDidKey:generated.vault.identity.publicDidKey,ownerRecoveryPublicKey:generated.vault.recovery.publicDidKey,scopes:["account:read","account:write"],credential:{credentialId:id,expiresAt:"2030-01-01T00:00:00.000Z"}});
   if(path.endsWith("/offer")){
    grantWire??=body;assert.deepEqual(body,grantWire);grant=decodeDeterministic(Buffer.from(body.payload,"base64url"));
    const common={version:1,did,nonce:grant.nonce,source_service_base:source+"/hail",destination_service_base:destination+"/hail",issued_at:grant.issued_at,expires_at:grant.expires_at};
    if(managed)ack??=await sign({...common,type:"hail.managed-transfer-acknowledgement",grant_digest:hash(Buffer.from(body.payload,"base64url")),source_messaging_key:sourceMessage.vault.identity.publicDidKey},sourceSigner);
    offer??=await sign({...common,type:managed?"hail.managed-transfer-offer":"hail.transfer-offer",transfer_id:id,grant_digest:hash(Buffer.from(body.payload,"base64url")),destination_rotation_key:targetKeys.vault.recovery.publicDidKey,destination_messaging_key:targetMessage.vault.identity.publicDidKey,...managed?{destination_identity_key:targetKeys.vault.identity.publicDidKey,acknowledgement_digest:hash(Buffer.from(ack.payload,"base64url"))}:{invitation_digest:new Uint8Array(32),invitation_challenge:new Uint8Array(32)}},targetSigner);
    return fail==="offer"?new Response("",{status:503}):json(status());
   }
   if(path==="/api/v1/account/transfers"||path==="/api/v1/account/transfers/managed")return json(status());
   if(path.endsWith("reservations")){
    selectionWire??=body;assert.deepEqual(body,selectionWire);const selected=decodeDeterministic(Buffer.from(body.payload,"base64url"));
    reservation??=await sign({type:managed?"hail.managed-transfer-reservation":"hail.transfer-reservation",version:1,did,nonce:grant.nonce,transfer_id:id,offer_digest:selected.offer_digest,selection_digest:hash(Buffer.from(body.payload,"base64url")),address:selected.address,issued_at:selected.issued_at,expires_at:selected.expires_at,...managed?{destination_rotation_key:targetKeys.vault.recovery.publicDidKey,destination_identity_key:targetKeys.vault.identity.publicDidKey,destination_messaging_key:targetMessage.vault.identity.publicDidKey}:{}},targetSigner);
    return fail==="reserve"?new Response("",{status:503}):json(reservation,202);
   }
   if(path.endsWith("/export"))return json(snapshot);
   if(path.endsWith("/cancel")){
    const cancelled=decodeDeterministic(Buffer.from(body.payload,"base64url"));cancelReceipt??=await sign({type:"hail.transfer-cancellation-receipt",version:1,did,nonce:grant.nonce,grant_digest:cancelled.grant_digest,invitation_digest:new Uint8Array(32),destination_domain:"destination.example.com",source_service_base:source+"/hail",issued_at:cancelled.issued_at,expires_at:cancelled.issued_at+604800},sourceSigner);
    return json({type:"hailp.transfer-cancellation",version:1,cancelled:true,sourceMessagingPublicKey:sourceMessage.vault.identity.publicDidKey,receipt:cancelReceipt});
   }
   if(path.endsWith("cancellations"))return new Response(null,{status:fail==="cancel"?503:204});
   if(path.endsWith("completions")){
    const operation=JSON.parse(Buffer.from(body.operation,"base64url").toString()),{sig,...unsigned}=operation;
    assert(await verifySignature(generated.vault.recovery.publicDidKey,encode(unsigned),Buffer.from(sig,"base64url")));
    const cid=(await cidForCbor(operation)).toString();
    if(fail==="complete")return new Response("",{status:503});
    const phase=fail==="monitor"?"awaiting-monitor":fail==="handover"?"awaiting-connection-handover":"active";
    activation??=await sign({type:"hail.portable-migration-activated",version:1,did,transfer_id:id,snapshot_digest:Buffer.from(snapshot.digest,"base64url"),destination_service_base:destination+"/hail",destination_messaging_key:targetMessage.vault.identity.publicDidKey,destination_address:"alice@destination.example.com",address_binding_digest:managed?new Uint8Array(32):hash(Buffer.from(body.binding,"base64url")),activated_at:Math.floor(Date.now()/1000)},targetSigner);
    return json({type:managed?"hailp.managed-transfer-completion":"hailp.transfer-completion",version:1,did,accountId:id,transferId:id,operationCid:cid,generation:2,phase,receipt:activation});
   }
   if(path.endsWith("retirements"))return new Response(null,{status:fail==="retire"?503:204});
   throw new Error(path);
  };
  async function run(args:string[],success=true,cmd=command){
   const child=Bun.spawn([...cmd,...args],{env,stdin:new Blob([secret+"\n"]),stdout:"pipe",stderr:"pipe"});const timer=setTimeout(()=>child.kill(),25000);
   const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);clearTimeout(timer);
   assert.equal(code===0,success,`${args.join(" ")}: ${err}`);assert(!(out+err).includes(secret));assert(!(out+err).includes(token));cases++;return out?JSON.parse(out):null;
  }
  await run(["account","show"]);
  const offerArgs=["account",group,"offer","--destination",destination,"--vault",vp,"--state",statePath];fail="offer";await run(offerArgs,false);fail="";await run(offerArgs);
  // Cancellation uses a separate retained state, so the successful transfer remains intact.
  if(!managed){const cp=prefix+".cancel";await writeFile(cp,await readFile(statePath),{mode:0o600});const cancel=["account","transfer","cancel","--vault",vp,"--state",cp];fail="cancel";await run(cancel,false);fail="";await run(cancel);await run(cancel,true,command);}
  const select=["account",group,"select","--username","alice","--vault",vp,"--state",statePath];fail="reserve";await run(select,false);fail="";assert.equal((await run(select)).requestAcknowledged,false);await run(select,true,command);await run(select.map(v=>v==="alice"?"bob":v),false);
  fenced=true;const previousCid=(await cidForCbor({fixture:true})).toString();
  const current={did,rotationKeys:[generated.vault.recovery.publicDidKey,sourceKeys.vault.recovery.publicDidKey],verificationMethods:{"hail-identity":managed?sourceKeys.vault.identity.publicDidKey:generated.vault.identity.publicDidKey,"hail-messaging":sourceMessage.vault.identity.publicDidKey},alsoKnownAs:[],services:{hail:{type:"HailMessaging",endpoint:source+"/hail"}}};
  const version=managed?6:5;
  const manifest={version,custodyProfile:managed?"managed":"portable",did,accountId:id,transferId:id,sourceServiceBase:source+"/hail",destinationServiceBase:destination+"/hail",destinationRotationPublicKey:targetKeys.vault.recovery.publicDidKey,destinationMessagingPublicKey:targetMessage.vault.identity.publicDidKey,...managed?{ownerRecoveryPublicKey:generated.vault.recovery.publicDidKey,sourceIdentityPublicKey:sourceKeys.vault.identity.publicDidKey,destinationIdentityPublicKey:targetKeys.vault.identity.publicDidKey,sourceGeneration:1,historyCheckpointDigest:b64(new Uint8Array(32))}:{},tables:{[managed?"managed_custody_evidence":"portable_custody_evidence"]:[managed?{owner_recovery_public_key:generated.vault.recovery.publicDidKey,provider_identity_public_key:sourceKeys.vault.identity.publicDidKey,verification_mode:"strict-public-v1"}:{user_recovery_public_key:generated.vault.recovery.publicDidKey,user_identity_public_key:generated.vault.identity.publicDidKey,monitor_verification_mode:"independent"}],account_keys:[{role:"plc-rotation",public_key:sourceKeys.vault.recovery.publicDidKey}],plc_operation_evidence:[{operation_cid:previousCid,expected_state:current}]}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest)),digest=hash(manifestBytes);
  snapshot={type:managed?"hail.managed-migration-transfer":"hail.portable-migration-transfer",version,manifest:b64(manifestBytes),digest:b64(digest),signature:b64(new Uint8Array(await crypto.subtle.sign("Ed25519",sourceSigner,Buffer.concat([Buffer.from(`hail-migration-snapshot-v${version}\0`),digest])))),sourceMessagingPublicKey:sourceMessage.vault.identity.publicDidKey};
  const exporting=["account",group,"export","--state",statePath,"--output",sp];await run(exporting);await run(exporting,true,command);
  const signing=["account",group,"sign-cutover","--vault",vp,"--state",statePath,"--snapshot",sp,"--operation",opPath,...managed?["--approval",approvalPath]:["--consent",approvalPath,"--binding",bindingPath]];
  const signed=await run(signing);const retained=await readFile(opPath);await run(signing,true,command);assert.deepEqual(await readFile(opPath),retained);
  await run(signing.map(v=>v===opPath?opPath+"-other":v),false);
  const completing=["account",group,"complete","--state",statePath,"--snapshot",sp,"--monitor-attestation",monitorPath];
  for(const pending of ["monitor","handover"]){fail=pending;assert.equal((await run(completing)).pending,true);assert.notEqual(JSON.parse(await readFile(statePath,"utf8")).retired,true);}
  fail="complete";await run(completing,false);fail="retire";await run(completing,false);fail="";assert.equal((await run(completing)).sourceRetired,true);await run(completing,true,command);
  assert.equal(JSON.parse(await readFile(statePath,"utf8")).retired,true);
  const completionBodies=calls.filter(c=>c.path.endsWith("completions")).map(c=>c.body);for(const body of completionBodies)assert.deepEqual(body,completionBodies[0]);
  const bad={...snapshot,digest:b64(new Uint8Array(32))};await writeFile(sp,JSON.stringify(bad));const before=calls.length;await run(completing,false);assert.equal(calls.length,before);
 }
 console.log(`Two-provider transfer regression: ${cases} cases passed`);
}finally{server?.stop(true);for(const socket of sockets)socket.destroy();proxy.close();await rm(directory,{recursive:true,force:true});}
