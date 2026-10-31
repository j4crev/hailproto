import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { Hono } from "hono";
import { createWebCryptoSigner, encodeBase64Url, inspectSignedPayload, signPayload } from "@hailproto/codec";
import type { ProviderDatabase } from "../../src/db/database.js";
import type { KeyEncryptor } from "../../src/identity/key-encryption.js";
import { importEd25519PrivateKey } from "../../src/identity/keys.js";
import type { HailDidResolver } from "../../src/plc/resolver.js";
import type { PlcDirectoryClient } from "../../src/plc/client.js";
import { AccountBinding } from "../../src/accounts/binding.js";
import { AccountApiRepository } from "../../src/accounts/repository.js";
import { OnboardingRepository } from "../../src/onboarding/repository.js";
import { AddressVerifier } from "../../src/discovery/verifier.js";
import { ADDRESS_BINDING_REL, registerDiscoveryRoutes } from "../../src/discovery/routes.js";

// Runs against the real completed custom signup, including retained admission,
// generated keys, public PLC evidence and passkey login from the parent fixture.
export async function exerciseCustomDomainPublication(db:ProviderDatabase,encryptor:KeyEncryptor,resolver:HailDidResolver,
  plc:PlcDirectoryClient,origin:string,address:string,signIn:()=>Promise<{token:string}>) {
  const accounts=new AccountApiRepository(db.sql),repository=new OnboardingRepository(db.sql);
  const issued=await accounts.issue(address,false,undefined,["account:read","account:write"]);
  const session=(await accounts.authenticate(`Bearer ${issued.token}`))!;
  const host=new URL(origin).hostname,discover=vi.fn(async():Promise<string|null>=>host);
  const app=new Hono();registerDiscoveryRoutes(app,origin,repository);
  const verifier=new AddressVerifier(plc,async request=>app.fetch(request),async url=>{
    expect(url.origin).toBe(origin);
  },()=>new Date(),resolver,discover);
  const binding=new AccountBinding(db.sql,resolver,encryptor,origin,verifier,discover);
  const originalBytes=(await repository.findPublishedByAddress(address))!.cose;
  const initial=await binding.show(session),old=inspectSignedPayload("hail.address-binding",originalBytes).payload;
  const intent={previous:initial.digest,signingKey:(await resolver.resolve(session.did)).identityDidKey,
    payload:{...old,issued_at:old.issued_at+1}};
  const snapshot=async()=>({
    account:await db.sql`SELECT id,did,onboarding_state FROM provider_accounts WHERE id=${session.account_id}`,
    keys:await db.sql`SELECT role,public_key FROM account_keys WHERE account_id=${session.account_id} ORDER BY role`,
    grants:await db.sql`SELECT grant_id,current_revision,current_status FROM grant_lineages WHERE local_account_id=${session.account_id} ORDER BY grant_id`,
  });
  const before=await snapshot();
  const count=async()=>Number((await db.sql`SELECT count(*) AS n FROM address_bindings WHERE account_id=${session.account_id}`)[0].n);
  const startCount=await count();
  for(const result of [null,"different-provider.example.com"]){
    discover.mockResolvedValue(result);
    await expect(binding.publish(session,intent)).rejects.toMatchObject({status:409});
    expect(await count()).toBe(startCount);
  }
  discover.mockRejectedValue(new Error("SERVFAIL"));
  await expect(binding.publish(session,intent)).rejects.toMatchObject({status:503});
  expect(await count()).toBe(startCount);
  // Login and existing DID authority do not depend on custom domain DNS.
  expect((await accounts.authenticate(undefined,(await signIn()).token))?.account_id).toBe(session.account_id);
  expect(await snapshot()).toEqual(before);

  discover.mockReset().mockResolvedValue(host).mockResolvedValueOnce(host).mockResolvedValueOnce(null);
  await expect(binding.publish(session,intent)).rejects.toMatchObject({status:409});
  expect(await count()).toBe(startCount+1); // Hosted, but never selected on failed second check.
  expect((await binding.show(session)).digest).toBe(initial.digest);
  expect(await db.sql`SELECT id FROM address_bindings WHERE account_id=${session.account_id} AND selected_at IS NULL AND published_at IS NULL`).toHaveLength(1);

  // Retired signup/issuance credentials and administrator state are not publication credentials.
  await db.sql`UPDATE custom_address_authorizations SET issued_at=now()-interval '1 hour',expires_at=now()-interval '45 minutes'
    WHERE canonical_address=${address}`;
  const published=await binding.publish(session,intent);
  expect(published.status).toBe("active");expect(await binding.publish(session,intent)).toEqual(published);
  expect(await count()).toBe(startCount+1);
  expect((await verifier.verify(address)).did).toBe(session.did);
  expect((await repository.findPublishedById(initial.bindingId))!.cose).toEqual(originalBytes);

  const next={...intent,previous:published.digest,payload:{...old,issued_at:old.issued_at+2}};
  discover.mockReset().mockResolvedValue(host).mockResolvedValueOnce(host).mockResolvedValueOnce(host).mockRejectedValueOnce(new Error("DNS failed after publication"));
  await expect(binding.publish(session,next)).rejects.toThrow();
  const selectedAfterFailure=await binding.show(session);
  expect(selectedAfterFailure.digest).not.toBe(published.digest);
  expect(await binding.publish(session,next)).toEqual(selectedAfterFailure);
  expect(await count()).toBe(startCount+2); // Lost verification never creates replacement bytes.

  // Removing local domain authority blocks publication even while DNS still points here.
  const domain=(await db.sql`SELECT d.id,d.verified_at FROM account_custom_domains d JOIN custom_address_authorizations a ON a.domain_id=d.id WHERE a.canonical_address=${address}`)[0];
  await db.sql`UPDATE account_custom_domains SET verified_at=NULL WHERE id=${domain.id}`;
  discover.mockClear();
  await expect(binding.publish(session,intent)).rejects.toMatchObject({status:409});expect(discover).not.toHaveBeenCalled();
  await db.sql`UPDATE account_custom_domains SET verified_at=${domain.verified_at} WHERE id=${domain.id}`;

  // A binding older than the former 90-day lifetime still resolves. Only its
  // issuance timestamp is old: PLC evidence and session authorization stay fresh.
  const now=Math.floor(Date.now()/1000),oldBinding={...old,issued_at:now-100*86400};
  expect(oldBinding.version).toBe(2);expect(oldBinding).not.toHaveProperty("expires_at");
  const key=await repository.getKey(session.account_id,"hail-identity"),raw=await encryptor.decrypt(session.account_id,key.role,key.algorithm,key.publicKey,key);
  let cose:Uint8Array;
  try{cose=await signPayload("hail.address-binding",oldBinding,createWebCryptoSigner(oldBinding.key_id,await importEd25519PrivateKey(raw)));}finally{raw.fill(0);}
  const digest=new Uint8Array(createHash("sha256").update(cose).digest());
  await db.sql.begin(async tx=>{
    await tx`UPDATE address_bindings SET selected_at=NULL WHERE account_id=${session.account_id}`;
    await tx`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
      VALUES(${randomUUID()},${session.account_id},${address},${session.did},${cose},${digest},${new Date(oldBinding.issued_at*1000)},NULL,now(),now(),now())`;
  });
  const url=`${origin}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${address}`)}&rel=${encodeURIComponent(ADDRESS_BINDING_REL)}`;
  expect(await binding.show(session)).toMatchObject({status:"active",digest:encodeBase64Url(digest)});
  expect(await binding.show(session)).not.toHaveProperty("renewalDue");
  expect((await app.request(url)).status).toBe(200);
  expect((await verifier.verify(address)).did).toBe(session.did);
  expect(await accounts.authenticate(`Bearer ${issued.token}`)).not.toBeNull();
  expect(await snapshot()).toEqual(before);
}
