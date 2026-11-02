import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {P256Keypair} from '@atproto/crypto';
import {createWebCryptoSigner,encodeBase64Url,signPayload} from '@racrproto/codec';
import type {SQL} from 'bun';
import {KeyEncryptor} from '../../src/identity/key-encryption.js';
import {generateAccountKeys} from '../../src/identity/keys.js';
import {PasskeyAuth} from '../../src/accounts/passkeys.js';
import {AccountApiRepository,type AccountApiSession} from '../../src/accounts/repository.js';
import type {AuthenticationResponseJSON} from '@simplewebauthn/server';
import {AccountConnections} from '../../src/accounts/connections.js';
import {ConnectionMessagingAuthority} from '../../src/accounts/connection-authorization.js';
import type {HailDidResolver} from '../../src/plc/resolver.js';

export async function sharedConversationFixture(sql:SQL){
  const origin='https://provider.example.com',encryptor=new KeyEncryptor(encodeBase64Url(randomBytes(32)));
  const passkeys=new PasskeyAuth(sql,'provider.example.com',origin),accounts=new AccountApiRepository(sql);
  const users:{id:string;did:string;address:string;keys:Awaited<ReturnType<typeof generateAccountKeys>>;credential:string;
    assertion:(challenge:string)=>AuthenticationResponseJSON;token:string;session:AccountApiSession}[]=[];
  for(const [i,name] of ['alice','bob','carol'].entries()){
    const id=randomUUID(),did='did:plc:'+String.fromCharCode(97+i).repeat(24),address=name+'@provider.example.com';
    const keys=await generateAccountKeys(id,encryptor),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),credential=encodeBase64Url(randomBytes(32));
    const cose=Buffer.concat([Buffer.from('a5010203262001215820','hex'),Buffer.from(jwk.x!,'base64url'),Buffer.from('225820','hex'),Buffer.from(jwk.y!,'base64url')]);
    await sql`INSERT INTO provider_accounts(id,tenant_id,canonical_address,did,onboarding_state,activated_at,activation_binding_digest,activation_verification_mode)
      VALUES(${id},${randomUUID()},${address},${did},'active',now(),${randomBytes(32)},'public')`;
    for(const key of keys.keys)await sql`INSERT INTO account_keys(account_id,role,algorithm,public_key,encrypted_private_key,encryption_nonce,encryption_version,kek_id)
      VALUES(${id},${key.role},${key.algorithm},${key.publicKey},${key.ciphertext},${key.nonce},${key.encryptionVersion},${key.kekId})`;
    await sql`INSERT INTO managed_custody_evidence(account_id,owner_recovery_public_key,provider_identity_public_key,verification_mode,managed_profile_version)
      VALUES(${id},${(await P256Keypair.create()).did()},${keys.identityDidKey},'reduced-assurance-alpha-v1','hail-managed-custody-v1')`;
    await sql`INSERT INTO account_passkeys(credential_id,account_id,serving_generation,public_key,device_type,backed_up,label)
      VALUES(${credential},${id},1,${cose},'singleDevice',false,'Conversation test')`;
    let counter=0;
    const assertion=(challenge:string)=>{
      const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin})),auth=Buffer.alloc(37);
      createHash('sha256').update('provider.example.com').digest().copy(auth);auth[32]=5;auth.writeUInt32BE(++counter,33);
      return {id:credential,rawId:credential,type:'public-key' as const,clientExtensionResults:{},response:{clientDataJSON:client.toString('base64url'),
        authenticatorData:auth.toString('base64url'),signature:sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),pair.privateKey).toString('base64url'),
        userHandle:Buffer.from(id.replaceAll('-',''),'hex').toString('base64url')}};
    };
    const now=Math.floor(Date.now()/1000),binding=await signPayload('hail.address-binding',{type:'hail.address-binding',version:2,address,did,issued_at:now-10,key_id:did+'#hail-identity'},createWebCryptoSigner(did+'#hail-identity',keys.identityPrivateKey));
    await sql`INSERT INTO address_bindings(id,account_id,canonical_address,did,cose,representation_digest,issued_at,expires_at,selected_at,published_at,hosted_at)
      VALUES(${randomUUID()},${id},${address},${did},${binding},${createHash('sha256').update(binding).digest()},${new Date((now-10)*1000)},NULL,now(),now(),now())`;
    const login=await passkeys.authenticationOptions(),signedIn=await passkeys.authenticate(login.challengeId,assertion(login.options.challenge));
    users.push({id,did,address,keys,credential,assertion,token:signedIn.token,session:(await accounts.authenticate(undefined,signedIn.token))!});
  }
  const resolver:HailDidResolver={async resolve(did){const u=users.find(u=>u.did===did);if(!u)throw Error('Unknown DID');return {did,identityDidKey:u.keys.identityDidKey,messagingDidKey:u.keys.messagingDidKey,serviceBase:origin+'/hail',evidence:{document:{},data:{},log:[]}};}};
  const connections=new AccountConnections(sql,encryptor,resolver,passkeys,origin);
  const [a,b,c]=users as [typeof users[number],typeof users[number],typeof users[number]];
  const review=await connections.prepare(a.session,{requestId:randomUUID(),action:'create',personal:true,label:'Conversation fixture',expiresAt:null});
  await connections.commit(a.session,review.requestId,a.assertion(review.options!.challenge));
  const code=(await connections.list(a.session)).codes[0]!;
  for(const user of [b,c]){
    const input=Object.fromEntries(new URLSearchParams(new URL(code.link).hash.slice(1)));
    const draft=await connections.prepare(user.session,{requestId:randomUUID(),action:'connect',...input});
    await connections.commit(user.session,draft.requestId,user.assertion(draft.options!.challenge));
    for(let n=0;n<30&&await connections.federation.workOne();n++);
  }
  const authority=new ConnectionMessagingAuthority(sql,resolver,origin+'/hail',connections.federation);
  return {a,b,c,users,origin,encryptor,passkeys,accounts,resolver,connections,authority};
}
