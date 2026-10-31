import {createHash,randomUUID} from 'node:crypto';
import {createWebCryptoVerifier,encodeDeterministic,verifySignedPayload} from '@hailproto/codec';
import {it,expect} from 'vitest';
import {ProviderDatabase} from '../src/db/database.js';
import {KeyEncryptor} from '../src/identity/key-encryption.js';
import {generateAccountKeys} from '../src/identity/keys.js';
import {ed25519PublicKeyFromDidKey} from '../src/identity/did-key.js';
import {OnboardingRepository} from '../src/onboarding/repository.js';
import {upgradeAddressBindings} from '../src/discovery/upgrade-bindings.js';
import type {HailDidResolver,ResolvedHailDid} from '../src/plc/resolver.js';

const integration=process.env.DATABASE_URL?it:it.skip;
integration('upgrades managed bindings atomically and only withdraws explicitly approved owners',async()=>{
  const db=new ProviderDatabase(process.env.DATABASE_URL!);
  const encryptor=new KeyEncryptor('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const origin='https://provider.example.com';
  const states=new Map<string,ResolvedHailDid>();
  const resolver:HailDidResolver={async resolve(did){return states.get(did)!;}};
  const accounts:{id:string;bindingId:string;address:string;did:string;cose:Uint8Array}[]=[];
  let delegation= 'provider.example.com';
  const discover=async()=>delegation;
  try{
    await db.migrate();
    for(let i=0;i<3;i++){
      const id=`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,did=`did:plc:${String.fromCharCode(97+i).repeat(24)}`;
      const address=i===1?'publisher@custom.example.com':`user${i}@provider.example.com`;
      const keys=await generateAccountKeys(id,encryptor);
      await db.sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
        VALUES(${id},${randomUUID()},${address},${did},'active',now(),${new Uint8Array(32)},'public')`;
      if(i<2){
        for(const key of keys.keys)await db.sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
          VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
        await db.sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
          VALUES(${id},${keys.rotationDidKey},${keys.identityDidKey},'poc-local','hail-managed-custody-v1')`;
      }
      const issued=Math.floor(Date.now()/1000)-1000,kid=`${did}#hail-identity`;
      // Construct real legacy signed bytes without reintroducing a v1 codec.
      const protectedBytes=Uint8Array.from([0xa3,1,0x32,3,...encodeDeterministic('application/hail-address-binding+cbor'),4,...encodeDeterministic(new TextEncoder().encode(kid))]);
      const payload=encodeDeterministic({type:'hail.address-binding',version:1,address,did,issued_at:issued,expires_at:issued+86400,key_id:kid});
      const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',keys.identityPrivateKey,
        Uint8Array.from(encodeDeterministic(['Signature1',protectedBytes,new Uint8Array(),payload]))));
      const cose=Uint8Array.from([0xd2,...encodeDeterministic([protectedBytes,{},payload,signature])]);
      const bindingId=randomUUID();
      await db.sql`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,hosted_at,selected_at,published_at)
        VALUES(${bindingId},${id},${address},${did},${cose},${new Uint8Array(createHash('sha256').update(cose).digest())},
          ${new Date(issued*1000)},${new Date((issued+86400)*1000)},now(),now(),now())`;
      states.set(did,{did,serviceBase:`${origin}/hail`,identityDidKey:keys.identityDidKey,messagingDidKey:keys.messagingDidKey,
        evidence:{document:{},data:{},log:[]}});
      accounts.push({id,bindingId,address,did,cose});
    }
    const run=(enabled=true,withdrawOwners:string[]=[])=>upgradeAddressBindings(db.sql,resolver,encryptor,origin,{enabled,withdrawOwners},discover);
    await expect(run(false)).rejects.toThrow('explicit v2 upgrade');
    await expect(run()).rejects.toThrow('owner signature');
    const owner=accounts[2]!;
    delegation='other.example.com';
    await expect(run(true,[owner.address])).rejects.toThrow('no longer delegates');
    expect(await db.sql`SELECT id FROM address_bindings WHERE expires_at IS NULL`).toHaveLength(0);
    expect(await db.sql`SELECT binding_id FROM address_binding_withdrawals`).toHaveLength(0);
    delegation='provider.example.com';
    const state=states.get(accounts[0]!.did)!;
    states.set(state.did,{...state,serviceBase:'https://other.example.com/hail'});
    await expect(run(true,[owner.address])).rejects.toThrow('PLC authority differs');
    states.set(state.did,state);
    expect(await run(true,[owner.address])).toEqual({upgraded:2,withdrawnOwners:1});
    const repository=new OnboardingRepository(db.sql);
    for(const account of accounts){
      expect(await repository.findPublishedById(account.bindingId)).toBeNull();
      expect(new Uint8Array((await db.sql`SELECT cose FROM address_bindings WHERE id=${account.bindingId}`)[0].cose)).toEqual(account.cose);
      const current=await repository.findPublishedByAddress(account.address);
      if(account===owner){expect(current).toBeNull();continue;}
      const verified=await verifySignedPayload('hail.address-binding',current!.cose,
        createWebCryptoVerifier(async()=>ed25519PublicKeyFromDidKey(states.get(account.did)!.identityDidKey)));
      expect(verified.payload).toMatchObject({version:2,address:account.address,did:account.did});
      expect(verified.payload).not.toHaveProperty('expires_at');
    }
    // Once converted, startup no longer requires the temporary opt-in or owner list.
    expect(await run(false)).toEqual({upgraded:0,withdrawnOwners:0});
    expect(await db.sql`SELECT id FROM provider_accounts`).toHaveLength(3);
  }finally{await db.close();}
});
