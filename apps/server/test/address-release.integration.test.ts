import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {ProviderDatabase} from '../src/db/database.js';
import {CustomDomains} from '../src/accounts/custom-domains.js';
import {AccountLifecycle,releaseAccountAddress} from '../src/accounts/lifecycle.js';
import {AccountApiRepository,tokenHash,type AccountApiSession} from '../src/accounts/repository.js';
import {OnboardingRepository} from '../src/onboarding/repository.js';
import {registerCustomDomainRoutes} from '../src/accounts/custom-domain-routes.js';

it.skipIf(!process.env.DATABASE_URL)('withdraws domains, quarantines reuse, and erases closed inboxes without transferring authority',async()=>{
 const db=new ProviderDatabase(process.env.DATABASE_URL!),origin='https://provider.example.com';
 const txt=vi.fn(async():Promise<string[][]>=>[]),dns=vi.fn(async()=> 'provider.example.com');
 const domains=new CustomDomains(db.sql,origin,txt,dns),accounts=new AccountApiRepository(db.sql),repo=new OnboardingRepository(db.sql);
 async function account(address:string){
  const id=randomUUID(),did='did:plc:'+Array.from(randomBytes(24),x=>'abcdefghijklmnopqrstuvwxyz234567'[x%32]).join('');
  await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activation_verification_mode,activated_at,activation_binding_digest)
   VALUES(${id},${randomUUID()},${address},${did},'active','public',now(),${randomBytes(32)})`;
  const passkey=randomBytes(32).toString('base64url'),sessionId=randomUUID(),token='hails_'+randomBytes(32).toString('base64url');
  await db.sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
   VALUES(${passkey},${id},1,${randomBytes(64)},'singleDevice',false,'test')`;
  await db.sql`INSERT INTO account_passkey_sessions(id,token_hash,account_id,credential_id,serving_generation,scopes,expires_at)
   VALUES(${sessionId},${tokenHash(token)},${id},${passkey},1,'["account:read","grants:read","messages:read","messages:write"]',now()+interval '1 hour')`;
  const session:AccountApiSession={account_id:id,did,canonical_address:address,credential_id:sessionId,credential_expires_at:new Date(Date.now()+3600000),
   migration_state:null,scopes:['account:read'],serving_generation:1,passkey_credential_id:passkey,passkey_verified_at:new Date()};
  const bindingId=randomUUID(),bytes=randomBytes(64);
  await db.sql`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,hosted_at,selected_at,published_at)
   VALUES(${bindingId},${id},${address},${did},${bytes},${randomBytes(32)},now(),now(),now(),now())`;
  return {session,id,did,token,bindingId};
 }
 // Only test code can age retained evidence; production never changes release timestamps.
 async function expire(){
  await db.sql.begin(async tx=>{
   await tx.unsafe('ALTER TABLE provider_accounts DISABLE TRIGGER hail_address_claim');
   await tx.unsafe('ALTER TABLE account_custom_domains DISABLE TRIGGER hail_domain_reclaim');
   await tx`UPDATE provider_accounts SET address_released_at=clock_timestamp()-interval '61 minutes' WHERE address_released_at IS NOT NULL AND closed_at IS NULL`;
   await tx`UPDATE account_custom_domains SET withdrawn_at=clock_timestamp()-interval '61 minutes' WHERE withdrawn_at IS NOT NULL`;
   await tx.unsafe('ALTER TABLE provider_accounts ENABLE TRIGGER hail_address_claim');
   await tx.unsafe('ALTER TABLE account_custom_domains ENABLE TRIGGER hail_domain_reclaim');
  });
 }
 try{
  await db.migrate();
  const rollback=await Bun.file(new URL('../migrations/rollback/0091_address_release.sql',import.meta.url)).text();
  await db.sql.begin(tx=>tx.unsafe(rollback));await db.migrate();
  const admin=await account('admin-user@provider.example.com'),old=await account('alice@custom.example.com'),next=await account('next@provider.example.com');
  expect(await repo.getLatestVerifiedSenderProfile(old.did)).toBeNull();
  const registration=await domains.start(admin.session,'custom.example.com');txt.mockResolvedValue([[registration.verificationValue!]]);await domains.verify(admin.session,registration.id);
  const pending=await domains.authorizeAddress(admin.session,registration.id,'pending@custom.example.com');
  const pendingClaim=await domains.start(next.session,'pending.example.com');
  await expect(domains.withdraw(next.session,pendingClaim.id,'pending.example.com')).rejects.toMatchObject({status:404});
  await expect(domains.withdraw(next.session,registration.id,'custom.example.com')).rejects.toMatchObject({status:404});
  await expect(domains.withdraw({...admin.session,passkey_verified_at:new Date(0)},registration.id,'custom.example.com')).rejects.toMatchObject({status:403});
  await expect(domains.withdraw({...admin.session,credential_id:randomUUID()},registration.id,'custom.example.com')).rejects.toMatchObject({status:403});
  await domains.withdraw(admin.session,registration.id,'custom.example.com');
  await domains.withdraw(admin.session,registration.id,'custom.example.com');
  expect(await repo.findPublishedByAddress(old.session.canonical_address)).toBeNull();expect(await repo.findPublishedById(old.bindingId)).toBeNull();
  expect(await repo.getAccountByDid(old.did)).toMatchObject({id:old.id,state:'active'});
  await expect(domains.checkAddressAuthorization(pending.token,pending.address)).rejects.toMatchObject({status:403});
  await expect(domains.start(next.session,'custom.example.com')).rejects.toMatchObject({status:409});
  await expect(account(old.session.canonical_address)).rejects.toThrow('quarantine');
  await expect(db.sql`UPDATE address_bindings SET selected_at=now() WHERE id=${old.bindingId}`).rejects.toThrow('Released addresses');
  await expect(db.sql`UPDATE provider_accounts SET address_released_at=NULL WHERE id=${old.id}`).rejects.toThrow('cannot be reassigned');
  await expect(db.sql.begin(tx=>tx.unsafe(rollback))).rejects.toThrow('rollback refused');
  await expire();
  const fresh=await domains.start(next.session,'custom.example.com');txt.mockResolvedValue([[registration.verificationValue!]]);
  expect((await domains.verify(next.session,fresh.id)).status).toBe('pending');
  await db.sql`UPDATE account_custom_domains SET next_check_at=now()-interval '1 second' WHERE id=${fresh.id}`;
  txt.mockResolvedValue([[fresh.verificationValue!]]);expect((await domains.verify(next.session,fresh.id)).status).toBe('verified');
  const freshAuthorization=await domains.authorizeAddress(next.session,fresh.id,pending.address);
  expect(freshAuthorization.token).not.toBe(pending.token);
  await expect(domains.checkAddressAuthorization(pending.token,pending.address)).rejects.toMatchObject({status:403});
  const reused=await account(old.session.canonical_address);
  expect((await repo.getAccountByAddress(old.session.canonical_address)).id).toBe(reused.id);
  expect((await repo.getAccountByDid(old.did))!.id).toBe(old.id);
  expect((await accounts.issue(old.did)).accountId).toBe(old.id);
  expect((await accounts.issue(old.session.canonical_address)).accountId).toBe(reused.id);
  expect((await repo.findPublishedByAddress(old.session.canonical_address))!.did).toBe(reused.did);
  expect(await repo.findPublishedById(old.bindingId)).toBeNull();
  const uniqueBytes=new TextEncoder().encode('private inbox body'),sharedBytes=new TextEncoder().encode('shared recipient body');
  const digest=(b:Uint8Array)=>new Uint8Array(createHash('sha256').update(b).digest());
  for(const [recipient,body] of [[old.did,uniqueBytes],[old.did,sharedBytes],[next.did,sharedBytes]] as const)
   await db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
    VALUES(${recipient},${admin.did},${digest(body)},'application/hail-body+cbor','spt-3',${body})`;
  const message=randomUUID(),bodyDigest=digest(uniqueBytes),envelopeDigest=randomBytes(32);
  await db.sql`INSERT INTO received_envelopes(sender_did,message_id,recipient_did,grant_id,local_account_id,envelope_cose,envelope_digest,
    payload_digest,signing_public_key,signing_plc_document,signing_plc_data,signing_plc_operation_log,outcome,accepted_at,authorization_type,connection_id,connection_epoch)
    VALUES(${admin.did},${message},${old.did},NULL,${old.id},${randomBytes(64)},${envelopeDigest},${randomBytes(32)},'did:key:test','{}','{}','[]','accepted',now(),'connection',${randomUUID()},1)`;
  await db.sql`INSERT INTO delivered_messages(recipient_did,sender_did,message_id,envelope_digest,body_digest,media_type,profile)
    VALUES(${old.did},${admin.did},${message},${envelopeDigest},${bodyDigest},'application/hail-body+cbor','spt-3')`;
  await db.sql`INSERT INTO delivery_work(sender_did,message_id) VALUES(${admin.did},${message})`;
  await db.sql`INSERT INTO terminal_status_publications(sender_did,message_id) VALUES(${admin.did},${message})`;
  await expect(new AccountLifecycle(db.sql).close({...old.session,credential_id:randomUUID()},old.session.canonical_address)).rejects.toMatchObject({status:403});
  const credential=await accounts.issue(old.did);
  const app=new Hono();registerCustomDomainRoutes(app,domains,accounts,origin);
  const headers={Origin:origin,'Content-Type':'application/json',Cookie:'hail_session='+old.token};
  // Ensure actual route dispatch closes the account, not just service calls.
  expect((await app.request(origin+'/api/v1/account/delete',{method:'POST',headers,body:JSON.stringify({address:old.session.canonical_address,eraseInbox:false})})).status).toBe(400);
  expect((await app.request(origin+'/api/v1/account/delete',{method:'POST',headers:{...headers,Origin:'https://foreign.example'},body:JSON.stringify({address:old.session.canonical_address,eraseInbox:true})})).status).toBe(403);
  const closed=await app.request(origin+'/api/v1/account/delete',{method:'POST',headers,body:JSON.stringify({address:old.session.canonical_address,eraseInbox:true})});
  expect(closed.status,await closed.clone().text()).toBe(200);expect(await closed.json()).toEqual({closed:true});
  expect(await accounts.authenticate('Bearer '+credential.token)).toBeNull();expect(await accounts.authenticate(undefined,old.token)).toBeNull();
  expect(await db.sql`SELECT message_id FROM delivered_messages WHERE recipient_did=${old.did}`).toHaveLength(0);
  expect((await db.sql`SELECT state FROM delivery_work WHERE sender_did=${admin.did} AND message_id=${message}`)[0].state).toBe('cancelled');
  expect((await db.sql`SELECT state,lease_token FROM terminal_status_publications WHERE sender_did=${admin.did} AND message_id=${message}`)[0]).toMatchObject({state:'blocked',lease_token:null});
  expect(await db.sql`SELECT digest FROM verified_body_provenance WHERE recipient_did=${old.did}`).toHaveLength(0);
  expect(await db.sql`SELECT digest FROM shared_content_blobs WHERE digest=${digest(uniqueBytes)}`).toHaveLength(0);
  expect(await db.sql`SELECT digest FROM shared_content_blobs WHERE digest=${digest(sharedBytes)}`).toHaveLength(1);
  expect(await repo.getAccountByDid(old.did)).toBeNull();expect((await repo.getAccountByAddress(reused.session.canonical_address)).id).toBe(reused.id);
  await expect(db.sql`INSERT INTO verified_body_provenance(recipient_did,sender_did,digest,media_type,profile,body_bytes)
   VALUES(${old.did},${admin.did},${digest(uniqueBytes)},'application/hail-body+cbor','spt-3',${uniqueBytes})`).rejects.toThrow('closed');
  await expect(db.sql`UPDATE provider_accounts SET closed_at=NULL WHERE id=${old.id}`).rejects.toThrow();
  await expect(new AccountLifecycle(db.sql).close(next.session,next.session.canonical_address)).rejects.toMatchObject({status:409});
  const migrated=await account('migrated@provider.example.com');
  await db.sql`INSERT INTO provider_retired_import_history(transfer_id,did,account_id,serving_generation,import_record)
    VALUES(${randomUUID()},${migrated.did},${migrated.id},1,'{}')`;
  await expect(new AccountLifecycle(db.sql).close(migrated.session,migrated.session.canonical_address)).rejects.toThrow('migration snapshots');
  // Releasing a native address uses the same quarantine and can roll back atomically.
  await expect(db.sql.begin(async tx=>{await releaseAccountAddress(tx,admin.id,'account-deletion');throw new Error('rollback probe');})).rejects.toThrow('rollback probe');
  expect((await repo.findPublishedByAddress(admin.session.canonical_address))!.did).toBe(admin.did);
  expect(await new AccountLifecycle(db.sql).close(admin.session,admin.session.canonical_address)).toEqual({closed:true});
  expect(await repo.findPublishedById(admin.bindingId)).toBeNull();
  await expect(account(admin.session.canonical_address)).rejects.toThrow('quarantine');
  // A concurrent reservation race still creates only one new independent account.
  const contenders=await Promise.allSettled([account('race@provider.example.com'),account('race@provider.example.com')]);
  expect(contenders.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 }finally{await db.close();}
},30000);
