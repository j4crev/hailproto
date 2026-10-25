import {createHash,randomBytes,randomUUID} from "node:crypto";
import {SQL} from "bun";
import {Hono} from "hono";
import {expect,it} from "vitest";
import {createWebCryptoSigner,encodeBase64Url,inspectSignedPayload,signPayload,type HailGrant} from "@hailproto/codec";
import {ProviderDatabase} from "../src/db/database.js";
import {AccountApiRepository} from "../src/accounts/repository.js";
import {AccountMessaging} from "../src/accounts/messaging.js";
import {AccountPublications} from "../src/accounts/publications.js";
import {registerAccountApiRoutes} from "../src/accounts/routes.js";
import {BodyRepository} from "../src/bodies/repository.js";
import {EnvelopeRepository} from "../src/envelopes/repository.js";
import {EnvelopeService} from "../src/envelopes/service.js";
import {GrantRepository} from "../src/grants/repository.js";
import {GrantService} from "../src/grants/service.js";
import {KeyEncryptor} from "../src/identity/key-encryption.js";
import {generateAccountKeys} from "../src/identity/keys.js";
import {uuidV7} from "../src/identity/uuid-v7.js";
import {OnboardingRepository} from "../src/onboarding/repository.js";
import {SenderProfileService} from "../src/profiles/service.js";
import type {HailDidResolver} from "../src/plc/resolver.js";
import {withFreshServingGenerations} from "../src/db/serving.js";

it.skipIf(!process.env.DATABASE_URL)("snapshots category audiences, resumes exact messages and gates cutover until publication work finishes",async()=>{
  const admin=new SQL(process.env.DATABASE_URL!),schema="publications_"+randomUUID().replaceAll("-","");
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const url=new URL(process.env.DATABASE_URL!);url.searchParams.set("options",`-csearch_path=${schema}`);
  const db=new ProviderDatabase(url.toString()),origin="https://publisher.example.com",base=origin+"/hail";
  const encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32))),evidence={document:{},data:{},log:[]};
  const users=[] as {id:string;did:string;address:string;keys:Awaited<ReturnType<typeof generateAccountKeys>>}[];
  try{
    await db.migrate();
    const rollback=await db.sql.reserve();try{await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0064_connection_federation.sql",import.meta.url)).text());await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0063_connection_owner_signing.sql",import.meta.url)).text());await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0062_connection_preview.sql",import.meta.url)).text());await rollback.unsafe(await Bun.file(new URL("../migrations/rollback/0061_publications.sql",import.meta.url)).text());}finally{rollback.release();}
    await db.migrate();
    for(const [i,name] of ["publisher","alice","bob","sales-only","late"].entries()){
      const id=randomUUID(),did="did:plc:"+String.fromCharCode(97+i).repeat(24),keys=await generateAccountKeys(id,encryptor),address=name+"@publisher.example.com";
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
      for(const key of keys.keys)await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
        VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
      users.push({id,did,address,keys});
    }
    const sender=users[0]!,onboarding=new OnboardingRepository(db.sql),grants=new GrantRepository(db.sql),envelopes=new EnvelopeRepository(db.sql),accounts=new AccountApiRepository(db.sql);
    const resolver:HailDidResolver={async resolve(did){const user=users.find(user=>user.did===did);if(!user)throw new Error("Unknown fixture identity");
      return {did,identityDidKey:user.keys.identityDidKey,messagingDidKey:user.keys.messagingDidKey,serviceBase:base,evidence};}};
    const profile=await new SenderProfileService(onboarding,encryptor,resolver,base).createOrReuse(sender.address,
      {display_name:"Publisher",offers_uncategorized:false,categories:[{id:"general",label:"General"},{id:"sales",label:"Sales"}]});
    const now=Math.floor(Date.now()/1000),binding={type:"hail.address-binding" as const,version:1 as const,address:sender.address,did:sender.did,issued_at:now,expires_at:now+86400,key_id:sender.did+"#hail-identity"};
    const raw=await signPayload("hail.address-binding",binding,createWebCryptoSigner(binding.key_id,sender.keys.identityPrivateKey));
    const hash=(bytes:Uint8Array)=>new Uint8Array(createHash("sha256").update(bytes).digest());
    const service=new GrantService(onboarding,grants,encryptor,resolver,{async verify(){return {address:sender.address,did:sender.did,binding,representation:raw,digest:hash(raw),
      serviceBase:base,identityDidKey:sender.keys.identityDidKey,messagingDidKey:sender.keys.messagingDidKey,plcEvidence:evidence,verifiedAt:new Date()};}},
      {async verify(){return {did:sender.did,profile:profile.payload,representation:profile.cose,digest:profile.digest,etag:encodeBase64Url(profile.digest),
        serviceBase:base,messagingDidKey:sender.keys.messagingDidKey,plcEvidence:evidence,verifiedAt:new Date()};}},base);
    const subscribe=async(index:number,category="general")=>{
      const grant=await service.createOrReuse(users[index]!.address,sender.address,{scope:{type:"categories",values:[category]},expiresAt:null});
      await grants.acceptReceivedRevision({...grant,localAccountId:sender.id});return grant;
    };
    await subscribe(1);const bob=await subscribe(2);await subscribe(3,"sales");
    let lose=1;const attempts=new Map<string,Uint8Array[]>();
    const messaging=new AccountMessaging(db.sql,new BodyRepository(db.sql),envelopes,new EnvelopeService(onboarding,grants,envelopes,encryptor,resolver,base),async(did,id)=>{
      const bytes=(await envelopes.sent(did,id))!;attempts.set(id,[...(attempts.get(id)??[]),bytes]);
      if(lose){lose--;throw new Error("Lost generic submission response");}return {messageId:id,outcome:"received",accepted:false};
    });
    let publications=new AccountPublications(db.sql,messaging);
    const credential=await accounts.issue(sender.address,false,undefined,["account:read","grants:read","messages:read","messages:write"]);
    const session=(await accounts.authenticate("Bearer "+credential.token))!;
    const reader=await accounts.issue(sender.address),other=await accounts.issue(users[1]!.address,false,undefined,["messages:read"]);
    const app=new Hono();registerAccountApiRoutes(app,accounts,grants,service,origin,messaging,undefined,undefined,undefined,undefined,undefined,undefined,origin,publications);
    const call=(path:string,input?:unknown,token=credential.token)=>app.request(origin+"/api/v1/account/publications"+path,{method:input===undefined?"GET":"POST",
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(input===undefined?{}:{body:JSON.stringify(input)})});
    expect((await call("/audiences")).status).toBe(200);
    expect(await publications.audiences(session)).toEqual({maxRecipients:100,categories:[{category:"general",subscribers:2},{category:"sales",subscribers:1}]});
    const input={publicationId:uuidV7(),category:"general",text:"Same body for the whole category",allowReplies:true};
    expect((await call("",input,reader.token)).status).toBe(403);
    expect((await call("",{...input,recipients:[users[1]!.did]})).status).toBe(400);
    expect((await call("",{...input,category:"unknown"})).status).toBe(409);
    const responses=await Promise.all([call("",input),call("",input)]);expect(responses.map(r=>r.status)).toEqual([202,202]);
    expect((await call("/"+input.publicationId,undefined,other.token)).status).toBe(404);
    expect((await (await call("",undefined,other.token)).json()).publications).toEqual([]);
    expect((await publications.recent(session)).publications).toMatchObject([{publicationId:input.publicationId,pending:true}]);
    expect((await call("",{...input,text:"Changed intent"})).status).toBe(409);
    await subscribe(4);
    expect((await publications.create(session,input)).total).toBe(2);
    await expect(db.sql`UPDATE account_publications SET category='sales' WHERE id=${input.publicationId}`).rejects.toThrow("intent cannot be replaced");
    const targetRows=()=>db.sql<{message_id:string;recipient_did:string}[]>`SELECT message_id,recipient_did FROM publication_targets WHERE publication_id=${input.publicationId}`;
    const targets=await targetRows(),alice=targets.find(t=>t.recipient_did===users[1]!.did)!;
    await expect(db.sql`INSERT INTO publication_targets(account_id,publication_id,grant_id,recipient_did,message_id)
      VALUES(${sender.id},${input.publicationId},${bob.payload.grant_id},${users[4]!.did},${uuidV7()})`).rejects.toThrow("already sealed");
    await db.sql`UPDATE publication_targets SET next_attempt_at=now()+interval '1 hour' WHERE recipient_did=${users[2]!.did}`;
    await publications.workOne();expect(attempts.get(alice.message_id)).toHaveLength(1);
    const bytesBefore=(await envelopes.sent(sender.did,alice.message_id))!;
    publications=new AccountPublications(db.sql,messaging); // process restart: no in-memory audience or retry state.
    await service.revoke(users[2]!.address,bob.payload.grant_id);
    await db.sql`UPDATE publication_targets SET next_attempt_at=now() WHERE state='pending'`;
    await publications.workOne();await publications.workOne();
    expect((await publications.status(session,input.publicationId))?.counts).toMatchObject({pending:0,submitted:1,blocked:1});
    expect((await publications.status(session,input.publicationId))?.delivery).toMatchObject({delivered:0,indeterminate:1});
    expect(await envelopes.sent(sender.did,alice.message_id)).toEqual(bytesBefore);
    expect(attempts.get(alice.message_id)).toEqual([bytesBefore,bytesBefore]);
    expect(await targetRows()).toHaveLength(2);
    const complete={...input,publicationId:uuidV7()};await publications.create(session,complete);
    await publications.workOne();await publications.workOne();
    const sent=await db.sql<{envelope_cose:Uint8Array}[]>`SELECT envelope_cose FROM sent_envelopes WHERE message_id IN (
      SELECT message_id FROM publication_targets WHERE publication_id=${complete.publicationId})`;
    expect(sent).toHaveLength(2);
    const payloads=sent.map(row=>inspectSignedPayload("hail.envelope",row.envelope_cose).payload);
    expect(payloads.map(p=>p.to).sort()).toEqual([users[1]!.did,users[4]!.did].sort());
    expect(payloads.every(p=>p.category==="general")).toBe(true);
    expect(Buffer.from(payloads[0]!.body.digest.value)).toEqual(Buffer.from(payloads[1]!.body.digest.value));
    expect(Buffer.from(payloads[0]!.body.access.token)).not.toEqual(Buffer.from(payloads[1]!.body.access.token));
    const cancel={...input,publicationId:uuidV7()};await publications.create(session,cancel);
    const fence=()=>db.sql`INSERT INTO provider_migration_fences(did,account_id,transfer_id,destination_service_base,state)
      VALUES(${sender.did},${sender.id},${randomUUID()},'https://destination.example.com/hail','fenced')`;
    await expect(fence()).rejects.toThrow("Finish or cancel");
    await expect(db.sql.begin(async tx=>{await tx`SELECT set_config('hail.returning_account',${sender.id},true)`;
      await tx`UPDATE account_serving_generations SET generation=generation+1 WHERE account_id=${sender.id}`;})).rejects.toThrow("Finish or cancel");
    expect((await call('/'+cancel.publicationId+'/cancel',{})).status).toBe(200);
    expect((await publications.status(session,cancel.publicationId))?.counts.cancelled).toBe(2);
    expect(await publications.workOne()).toBe(false);
    // Cancellation after an ambiguous submission retains the exact already-created envelope's retry.
    const partial={...input,publicationId:uuidV7()};await publications.create(session,partial);lose=1;
    await publications.workOne();await publications.cancel(session,partial.publicationId);
    expect((await publications.status(session,partial.publicationId))?.counts).toMatchObject({pending:1,cancelled:1});
    await db.sql`UPDATE publication_targets SET next_attempt_at=now() WHERE state='pending'`;
    await publications.workOne();expect((await publications.status(session,partial.publicationId))?.counts).toMatchObject({pending:0,submitted:1,cancelled:1});
    // Shorten only the test schema's default for a newly admitted intent, never mutate retained deadlines.
    await db.sql.unsafe("ALTER TABLE account_publications ALTER COLUMN expires_at SET DEFAULT clock_timestamp()+interval '100 milliseconds'");
    const expired={...input,publicationId:uuidV7()};await publications.create(session,expired);await Bun.sleep(150);
    await publications.workOne();expect((await publications.status(session,expired.publicationId))?.counts.expired).toBe(2);
    await db.sql.unsafe("ALTER TABLE account_publications ALTER COLUMN expires_at SET DEFAULT clock_timestamp()+interval '24 hours'");
    const open=[] as string[];
    for(let i=0;i<5;i++){const publicationId=uuidV7();await publications.create(session,{...input,publicationId});open.push(publicationId);}
    await expect(publications.create(session,{...input,publicationId:uuidV7()})).rejects.toThrow("Finish or cancel open");
    expect((await publications.create(session,{...input,publicationId:open[0]!})).total).toBe(2);
    for(const id of open)await publications.cancel(session,id);
    // Remote subscribers need no local account; exercise the admission ceiling against the full query, not a GUI count.
    for(let i=0;i<100;i++){
      const grantor="did:plc:"+"z".repeat(22)+"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i/32)]+"abcdefghijklmnopqrstuvwxyz234567"[i%32];
      const payload:HailGrant={type:"hail.grant",version:1,grant_id:uuidV7(),revision:1,previous:null,grantor,grantee:sender.did,
        scope:[{type:"categories" as const,values:["general"]}],status:"active" as const,issued_at:now,updated_at:now,expires_at:null,
        consent_context:bob.payload.consent_context,key_id:grantor+"#hail-identity"};
      const representation=await signPayload("hail.grant",payload,createWebCryptoSigner(payload.key_id,users[1]!.keys.identityPrivateKey));
      await grants.acceptReceivedRevision({localAccountId:sender.id,payload,representation,digest:hash(representation),
        signingPublicKey:users[1]!.keys.identityDidKey,signingPlcEvidence:evidence});
    }
    const overLimit=uuidV7();await expect(publications.create(session,{...input,publicationId:overLimit})).rejects.toThrow("between 1 and 100");
    expect(await publications.status(session,overLimit)).toBeNull();
    const retained=await db.sql.reserve();try{await expect(retained.unsafe(await Bun.file(new URL("../migrations/rollback/0061_publications.sql",import.meta.url)).text())).rejects.toThrow("prevents rollback");}
      finally{await retained.unsafe("ROLLBACK");retained.release();}
    await fence();expect((await call("",{...input,publicationId:uuidV7()})).status).toBe(409);
    expect(await withFreshServingGenerations(db.sql,()=>publications.workOne())).toBe(false);
  }finally{await db.close();await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.close();}
},60_000);
